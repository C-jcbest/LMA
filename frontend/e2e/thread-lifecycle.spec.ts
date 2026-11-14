import { expect, test, type Page } from '@playwright/test';
import { LmaClient } from '../src/services/api';

const client = new LmaClient('http://127.0.0.1:21420');

async function createThread(name: string) {
  const session = await client.createSession();
  await client.updateSession(session.id, { name });
  return session.id;
}

async function seedThread(threadId: string, message: string) {
  const messages = [{ type: 'human' as const, id: crypto.randomUUID(), content: message }];
  for await (const event of client.streamRun(threadId, messages, { signal: new AbortController().signal })) {
    if (event.event === 'error') throw new Error('隔离会话初始化失败');
  }
}

async function openThread(page: Page, threadId: string) {
  await page.goto(`/?threadId=${encodeURIComponent(threadId)}`);
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeVisible();
}

async function send(page: Page, message: string) {
  const composer = page.getByRole('textbox', { name: '输入监测问题' });
  await composer.fill(message);
  await page.getByRole('button', { name: '发送消息' }).click();
}

async function switchThread(page: Page, name: string, threadId: string) {
  await page
    .locator('[data-slot="aui_thread-list-item-trigger"]')
    .filter({ hasText: name })
    .click();
  await expect(page).toHaveURL(new RegExp(`threadId=${threadId}`));
}

function persistedText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { text: string } => Boolean(part && typeof part === 'object' && 'text' in part))
    .map((part) => part.text)
    .join('');
}

function expectToolCallsPaired(messages: Array<Record<string, unknown>>) {
  const toolResultIds = new Set(
    messages
      .filter((message) => message.type === 'tool' && typeof message.tool_call_id === 'string')
      .map((message) => message.tool_call_id as string),
  );
  const toolCallIds = messages.flatMap((message) => {
    if (message.type !== 'ai' || !Array.isArray(message.tool_calls)) return [];
    return message.tool_calls
      .filter((call): call is { id: string } => Boolean(
        call && typeof call === 'object' && 'id' in call && typeof call.id === 'string',
      ))
      .map((call) => call.id);
  });
  expect(toolCallIds.filter((id) => !toolResultIds.has(id))).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('lma_api_url', '/api');
  });
});

test('测点调查发送到自己的会话，离开页面不停止，返回后恢复完成结果', async ({ page }) => {
  const stationUuid = '11111111-1111-1111-1111-111111111111';
  let dedicated: { id: string; station_uuid: string } | undefined;
  const unrelated = await createThread('其他测点的会话');
  try {
    await seedThread(unrelated, '其他测点的旧消息');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?station=${stationUuid}&threadId=${unrelated}`);
    await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
    await expect(page.getByText('已继续处理：其他测点的旧消息')).toHaveCount(0);
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/sessions'));
    await send(page, '请慢速回答切换会话场景');
    dedicated = await (await created).json();
    expect(dedicated?.station_uuid).toBe(stationUuid);
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page).toHaveURL(/page=stations/);
    await page.getByRole('list', { name: '测点列表' }).getByRole('button', { name: /E2E空数据站/ }).click();
    await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
    await expect(page.getByText('慢速生成已完成，切换会话后状态与内容保持一致。')).toBeVisible();
    const unchanged = JSON.stringify((await client.getState(unrelated)).values.messages);
    expect(unchanged).not.toContain('请慢速回答切换会话场景');
    await page.reload();
    await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
    await expect(page.getByText('慢速生成已完成，切换会话后状态与内容保持一致。')).toBeVisible();
  } finally {
    if (dedicated) {
      await client.cancelRun(dedicated.id);
      await client.deleteSession(dedicated.id);
    }
    await client.deleteSession(unrelated);
  }
});

test('深链接、浏览器前进后退与刷新保持同一 Thread', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const firstName = `导航会话一-${suffix}`;
  const secondName = `导航会话二-${suffix}`;
  const firstId = await createThread(firstName);
  const secondId = await createThread(secondName);

  try {
    await seedThread(firstId, '浏览器导航第一条消息');
    await seedThread(secondId, '浏览器导航第二条消息');

    await openThread(page, firstId);
    await expect(page.getByText('已继续处理：浏览器导航第一条消息')).toBeVisible();

    await switchThread(page, secondName, secondId);
    await expect(page.getByText('已继续处理：浏览器导航第二条消息')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`threadId=${firstId}`));
    await expect(page.getByText('已继续处理：浏览器导航第一条消息')).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`threadId=${secondId}`));
    await expect(page.getByText('已继续处理：浏览器导航第二条消息')).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`threadId=${secondId}`));
    await expect(page.getByText('已继续处理：浏览器导航第二条消息')).toBeVisible();
  } finally {
    await client.deleteSession(firstId);
    await client.deleteSession(secondId);
  }
});

test('并行工具执行中 Stop：刷新、继续提问与切换 Thread 后状态仍合法', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const threadName = `Stop 生命周期-${suffix}`;
  const otherName = `Stop 切换目标-${suffix}`;
  const threadId = await createThread(threadName);
  const otherId = await createThread(otherName);
  try {
    await seedThread(otherId, 'Stop 场景切换目标');
    await openThread(page, threadId);
    await send(page, '执行并行工具停止验证');
    await expect(page.getByText(/正在查询监测点….*已完成 1 项/)).toBeVisible();
    const cancellation = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith(`/sessions/${threadId}/cancel`),
    );
    await page.getByRole('button', { name: '停止生成' }).click();
    expect((await cancellation).status()).toBe(204);
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`threadId=${threadId}`));
    await send(page, '停止后继续提问');
    await expect(page.getByText('已继续处理：停止后继续提问')).toBeVisible();
    // 流式正文先于最终 checkpoint 到达；持久化断言等待本轮真正结束。
    await expect.poll(async () => (await client.getState(threadId)).latest_run?.status).toBe('success');

    await switchThread(page, otherName, otherId);
    await expect(page.getByText('已继续处理：Stop 场景切换目标')).toBeVisible();
    await switchThread(page, threadName, threadId);
    await expect(page.getByText('已继续处理：停止后继续提问')).toBeVisible();

    const state = await client.getState(threadId);
    const messages = (state.values as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    expect(messages.some((message) => message.type === 'human' && persistedText(message.content) === '停止后继续提问')).toBe(true);
    expect(messages.some((message) => message.type === 'ai' && persistedText(message.content) === '已继续处理：停止后继续提问')).toBe(true);
    expectToolCallsPaired(messages);
    expect(messages.some((message) => message.type === 'tool' && message.name === 'get_displacement' && message.status === 'success')).toBe(true);
    expect(messages.some((message) => message.type === 'tool' && message.name === 'find_stations' && message.status === 'error')).toBe(true);
  } finally {
    await client.deleteSession(threadId);
    await client.deleteSession(otherId);
  }
});

test('重新生成使用 checkpoint fork，刷新后显示最新回答', async ({ page }) => {
  const threadId = await createThread('Regenerate 分支');
  try {
    await openThread(page, threadId);
    await send(page, '分支重试验证');
    const original = page.getByText(/分支回答版本 \d+/).last();
    await expect(original).toBeVisible();
    const originalText = await original.textContent();

    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await assistantMessage.hover();
    const regenerationRequest = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url().endsWith(`/sessions/${threadId}/runs`),
    );
    await assistantMessage.getByRole('button', { name: '重新生成' }).click();

    const request = await regenerationRequest;
    expect(request.postDataJSON().checkpoint_id).toBeTruthy();
    expect((await request.response())?.status()).toBe(200);
    await expect(page.getByText(/分支回答版本 \d+/).last()).not.toHaveText(originalText ?? '');
    const regenerated = page.getByText(/分支回答版本 \d+/).last();
    const regeneratedText = await regenerated.textContent();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
    await page.reload();
    await expect(page.getByText(regeneratedText ?? '', { exact: true })).toBeVisible();
    await expect(page.getByText(originalText ?? '', { exact: true })).toHaveCount(0);
  } finally {
    await client.deleteSession(threadId);
  }
});

test('调查记录滚动加载下一页，整页耗尽后隐藏加载入口，侧栏只留最近几条', async ({ page }) => {
  // 隔离持久化的历史测试数据，只替换列表 HTTP 响应，运行真实 Runtime 与浏览器布局。
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `pagination-${index}`,
    name: `滚动分页-${index}`, archived: false,
    created_at: '2026-09-21T00:00:00Z',
    updated_at: '2026-09-21T00:00:00Z',
    status: 'idle',
  }));
  const offsets: number[] = [];
  await page.route('**/api/sessions?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get('offset'));
    const limit = Number(query.get('limit'));
    offsets.push(offset);
    await route.fulfill({ json: rows.slice(offset, offset + limit) });
  });
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/?page=records');
  const records = page.getByRole('region', { name: '调查记录' });
  const items = records.locator('[data-slot="aui_thread-list-item"]');
  await expect(items).toHaveCount(20);
  await expect(page.getByRole('complementary', { name: '导航' }).locator('[data-slot="aui_thread-list-item"]')).toHaveCount(5);
  const viewport = records.locator('[data-slot="aui_thread-list-viewport"]');
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const heading = records.getByRole('heading', { name: '调查记录' });
  const before = await heading.boundingBox();
  await viewport.hover();
  await page.mouse.wheel(0, 2000);
  await expect(items).toHaveCount(40);
  await expect(page.getByRole('button', { name: /加载.*会话/ })).toHaveCount(0);
  expect((await heading.boundingBox())?.y).toBe(before?.y);
  expect(offsets).toEqual([0, 20]);
});

test('最新用户消息可编辑重新生成、复制，悬停不改变消息位置', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const threadId = await createThread('编辑与复制');
  try {
    await seedThread(threadId, '编辑前的问题');
    await openThread(page, threadId);
    await expect(page.getByText('已继续处理：编辑前的问题')).toBeVisible();
    const user = page.locator('[data-role="user"]').last();
    const assistant = page.locator('[data-role="assistant"]').last();
    await page.getByRole('textbox', { name: '输入监测问题' }).hover();
    await expect(user.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
    const before = await assistant.boundingBox();
    await user.hover();
    await user.getByRole('button', { name: '复制消息' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('编辑前的问题');
    await assistant.hover();
    await expect(assistant.getByRole('button', { name: '复制', exact: true })).toBeVisible();
    const after = await assistant.boundingBox();
    expect(after?.y).toBe(before?.y);
    expect(after?.height).toBe(before?.height);
    await user.hover();
    await user.getByRole('button', { name: '编辑消息' }).click();
    await page.getByRole('textbox', { name: '编辑用户消息' }).fill('修改后的问题');
    await page.getByRole('button', { name: '保存并重新生成' }).click();
    await expect(page.getByText('已继续处理：修改后的问题')).toBeVisible();
    await page.reload();
    await expect(page.getByText('已继续处理：修改后的问题')).toBeVisible();
    await send(page, '下一轮问题');
    await expect(page.getByText('已继续处理：下一轮问题')).toBeVisible();
    const oldUser = page.locator('[data-role="user"]').first();
    await oldUser.hover();
    await expect(oldUser.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
    await expect(oldUser.getByRole('button', { name: '复制消息' })).toBeVisible();
    await user.hover();
    await user.getByRole('button', { name: '编辑消息' }).click();
    await page.getByRole('textbox', { name: '编辑用户消息' }).fill('第二轮修改');
    await page.getByRole('button', { name: '保存并重新生成' }).click();
    await expect(page.getByText('已继续处理：第二轮修改')).toBeVisible();
    // 文字出现时 Run 可能仍在收尾，结束后才允许删除会话。
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  } finally {
    await client.deleteSession(threadId);
  }
});
