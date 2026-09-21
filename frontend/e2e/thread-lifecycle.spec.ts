import { expect, test, type Page } from '@playwright/test';
import { Client } from '@langchain/langgraph-sdk';

const apiUrl = 'http://127.0.0.1:21420';
const client = new Client({ apiUrl, callerOptions: { maxRetries: 0 } });

async function createThread(name: string) {
  const thread = await client.threads.create({
    metadata: { graph_id: 'lma-agent', name },
  });
  return thread.thread_id;
}

async function seedThread(threadId: string, message: string) {
  await client.runs.wait(threadId, 'lma-agent', {
    input: { messages: [{ role: 'user', content: message }] },
  });
}

async function openThread(page: Page, threadId: string) {
  await page.goto(`/?threadId=${encodeURIComponent(threadId)}`);
  await expect(page.getByPlaceholder('询问监测数据、变化趋势、降雨关联或场地环境…')).toBeVisible();
}

async function send(page: Page, message: string) {
  const composer = page.getByPlaceholder('询问监测数据、变化趋势、降雨关联或场地环境…');
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
  expect(toolCallIds.every((id) => toolResultIds.has(id))).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('lma_langgraph_config', 'http://127.0.0.1:21420');
  });
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
    await client.threads.delete(firstId);
    await client.threads.delete(secondId);
  }
});

test('生成中切换会话再返回：后台 Run 继续且返回后恢复状态与内容', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const activeName = `生成中会话-${suffix}`;
  const otherName = `后台会话-${suffix}`;
  const activeId = await createThread(activeName);
  const otherId = await createThread(otherName);

  try {
    await seedThread(activeId, '准备生成会话');
    await seedThread(otherId, '准备后台会话');
    await openThread(page, activeId);
    await send(page, '请慢速回答切换会话场景');
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();

    await switchThread(page, otherName, otherId);
    await expect(page.getByText('已继续处理：准备后台会话')).toBeVisible();
    await switchThread(page, activeName, activeId);

    await expect(page.getByText('慢速生成已完成，切换会话后状态与内容保持一致。')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  } finally {
    await client.threads.delete(activeId);
    await client.threads.delete(otherId);
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
    await expect(page.getByText('正在获取辅助信息…')).toBeVisible();
    await expect(page.getByText('正在查询监测点分组…')).toBeVisible();
    await page.getByRole('button', { name: '停止生成' }).click();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`threadId=${threadId}`));
    await send(page, '停止后继续提问');
    await expect(page.getByText('已继续处理：停止后继续提问')).toBeVisible();

    await switchThread(page, otherName, otherId);
    await expect(page.getByText('已继续处理：Stop 场景切换目标')).toBeVisible();
    await switchThread(page, threadName, threadId);
    await expect(page.getByText('已继续处理：停止后继续提问')).toBeVisible();

    const state = await client.threads.getState(threadId);
    const messages = (state.values as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    expect(messages.some((message) => message.type === 'human' && persistedText(message.content) === '停止后继续提问')).toBe(true);
    expect(messages.some((message) => message.type === 'ai' && persistedText(message.content) === '已继续处理：停止后继续提问')).toBe(true);
    expectToolCallsPaired(messages);
  } finally {
    await client.threads.delete(threadId);
    await client.threads.delete(otherId);
  }
});

test('Regenerate 使用 checkpoint fork，并形成可切换的回答分支', async ({ page }) => {
  const threadId = await createThread('Regenerate 分支');
  try {
    await openThread(page, threadId);
    await send(page, '分支重试验证');
    const original = page.getByText(/分支回答版本 \d+/).last();
    await expect(original).toBeVisible();
    const originalText = await original.textContent();

    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: 'Refresh' }).click();

    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await expect(page.getByText(/分支回答版本 \d+/).last()).not.toHaveText(originalText ?? '');
    await expect(assistantMessage.getByText(/2\s*\/\s*2/)).toBeVisible();
  } finally {
    await client.threads.delete(threadId);
  }
});

test('Tool error、空结果与 artifact 在刷新后仍由持久化 ToolMessage 恢复', async ({ page }) => {
  const errorThreadId = await createThread('工具错误');
  const emptyThreadId = await createThread('工具空结果');
  try {
    await openThread(page, errorThreadId);
    await send(page, '查询不存在监测点的 GNSS 数据');
    const errorTool = page.getByRole('button', { name: /GNSS 数据获取失败/ });
    await expect(errorTool).toBeVisible();
    await errorTool.click();
    await expect(page.getByText(/未找到名称包含“不存在监测点”的监测点/)).toBeVisible();

    await page.reload();
    await expect(errorTool).toBeVisible();
    await errorTool.click();
    await expect(page.getByText(/未找到名称包含“不存在监测点”的监测点/)).toBeVisible();

    await openThread(page, emptyThreadId);
    await send(page, '查询空结果监测点的 GNSS 数据');
    const emptyTool = page.getByRole('button', { name: /已获取 GNSS 监测数据/ });
    await expect(emptyTool).toBeVisible();
    await emptyTool.click();
    await expect(page.getByText(/该时间范围内暂无 GNSS 数据/)).toBeVisible();

    await page.reload();
    await expect(emptyTool).toBeVisible();
    await emptyTool.click();
    await expect(page.getByText(/该时间范围内暂无 GNSS 数据/)).toBeVisible();
  } finally {
    await client.threads.delete(errorThreadId);
    await client.threads.delete(emptyThreadId);
  }
});

test('展开和收起工具时消息列不发生横向位移', async ({ page }) => {
  const threadId = await createThread('折叠内容布局稳定性');
  try {
    for (let index = 0; index < 8; index += 1) {
      await seedThread(
        threadId,
        `填充滚动区域 ${index + 1}：保持消息列宽度稳定并验证折叠内容不会引起横向抖动。`,
      );
    }
    await openThread(page, threadId);
    await send(page, '查询空结果监测点的 GNSS 数据');

    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    await expect.poll(() =>
      viewport.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);

    const tool = page.getByRole('button', { name: /已获取 GNSS 监测数据/ });
    await expect(tool).toBeVisible();
    const messageColumn = page.locator('[data-slot="aui_message-group"]');
    const x = async () => (await messageColumn.boundingBox())?.x;
    const before = await x();

    await tool.click();
    await page.waitForTimeout(50);
    expect(Math.abs((await x())! - before!)).toBeLessThan(0.5);
    await page.waitForTimeout(200);
    expect(Math.abs((await x())! - before!)).toBeLessThan(0.5);

    await tool.click();
    await page.waitForTimeout(50);
    expect(Math.abs((await x())! - before!)).toBeLessThan(0.5);
  } finally {
    await client.threads.delete(threadId);
  }
});


test('会话栏滚动加载下一页，整页耗尽后隐藏加载入口', async ({ page }) => {
  // 隔离持久化的历史测试数据，只替换列表 HTTP 响应，运行真实 Runtime 与浏览器布局。
  const rows = Array.from({ length: 40 }, (_, index) => ({
    thread_id: `pagination-${index}`,
    metadata: { graph_id: 'lma-agent', name: `滚动分页-${index}` },
    created_at: '2026-09-21T00:00:00Z',
    updated_at: '2026-09-21T00:00:00Z',
    status: 'idle',
  }));
  const offsets: number[] = [];
  await page.route('**/threads/search', async (route) => {
    const { offset = 0, limit } = route.request().postDataJSON();
    offsets.push(offset);
    await route.fulfill({ json: rows.slice(offset, offset + limit) });
  });
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/');
  const items = page.locator('[data-slot="aui_thread-list-item"]');
  await expect(items).toHaveCount(20);
  const viewport = page.locator('[data-slot="aui_thread-list-viewport"]');
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const newButton = page.getByRole('button', { name: '新建会话', exact: true });
  const before = await newButton.boundingBox();
  await viewport.hover();
  await page.mouse.wheel(0, 2000);
  await expect(items).toHaveCount(40);
  await expect(page.getByRole('button', { name: /加载.*会话/ })).toHaveCount(0);
  expect((await newButton.boundingBox())?.y).toBe(before?.y);
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
    await page.getByPlaceholder('询问监测数据、变化趋势、降雨关联或场地环境…').hover();
    await expect(user.getByRole('button', { name: '编辑消息' })).toHaveCount(0);
    const before = await assistant.boundingBox();
    await user.hover();
    await user.getByRole('button', { name: '复制消息' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('编辑前的问题');
    await assistant.hover();
    await expect(assistant.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
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
  } finally {
    await client.threads.delete(threadId);
  }
});


for (const mode of ['数值', '视觉']) {
  test(`基准站${mode}请求仅向模型说明，刷新后也不出现错误卡片`, async ({ page }) => {
    const threadId = await createThread(`基准站${mode}`);
    try {
      await openThread(page, threadId);
      await send(page, `查询基准站${mode}数据`);
      await expect(page.getByText('该站仅提供差分基准，不适用形变序列分析。')).toBeVisible();
      await expect(page.locator('[data-role="assistant"] button').filter({ hasText: /GNSS|视觉/ })).toHaveCount(0);
      const state = await client.threads.getState(threadId);
      const messages = (state.values as { messages: Array<Record<string, unknown>> }).messages;
      const result = messages.find((message) => message.type === 'tool');
      expect(result?.artifact).toBeNull();
      expect(persistedText(result?.content)).toContain('未查询形变数据');
      await page.reload();
      await expect(page.getByText('该站仅提供差分基准，不适用形变序列分析。')).toBeVisible();
      await expect(page.locator('[data-role="assistant"] button').filter({ hasText: /GNSS|视觉/ })).toHaveCount(0);
    } finally {
      await client.threads.delete(threadId);
    }
  });
}
