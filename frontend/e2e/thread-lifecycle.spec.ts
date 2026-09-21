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

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('lma_langgraph_config', 'http://127.0.0.1:21420');
  });
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

test('Stop 后继续提问：取消当前 Run 后直接创建正常新 Run', async ({ page }) => {
  const threadId = await createThread('Stop 生命周期');
  try {
    await openThread(page, threadId);
    await send(page, '请慢速生成一段可停止的回答');
    await page.getByRole('button', { name: '停止生成' }).click();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();

    await send(page, '停止后继续提问');
    await expect(page.getByText('已继续处理：停止后继续提问')).toBeVisible();

    const state = await client.threads.getState(threadId);
    const messages = (state.values as { messages?: Array<{ type?: string; content?: unknown }> }).messages ?? [];
    expect(messages.some((message) => message.type === 'human' && persistedText(message.content) === '停止后继续提问')).toBe(true);
    expect(messages.some((message) => message.type === 'ai' && persistedText(message.content) === '已继续处理：停止后继续提问')).toBe(true);
  } finally {
    await client.threads.delete(threadId);
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
    await expect(page.getByText(/已加载 0 条采样记录/)).toBeVisible();

    await page.reload();
    await expect(emptyTool).toBeVisible();
    await emptyTool.click();
    await expect(page.getByText(/已加载 0 条采样记录/)).toBeVisible();
  } finally {
    await client.threads.delete(errorThreadId);
    await client.threads.delete(emptyThreadId);
  }
});
