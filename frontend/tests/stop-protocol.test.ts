import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@langchain/langgraph-sdk';
import { getInterruptedToolMessages, prepareThreadInput, projectLangGraphMessages } from '../src/services/api';

const human = { type: 'human', content: '查询' };
const ai = (...ids: string[]) => ({ type: 'ai', content: '', tool_calls: ids.map((id) => ({ id, name: 'list_stations', args: {} })) });
const tool = (id: string) => ({ type: 'tool', content: '真实结果', name: 'list_stations', tool_call_id: id, status: 'success', artifact: { data: { message: '真实证据' } } });
describe('当前中止Run的下一轮协议输入', () => {
  it.each([
    [[human, { type: 'ai', content: '', additional_kwargs: { reasoning_content: '思考中' } }], []],
    [[human, ai('single')], ['single']],
    [[human, ai('done', 'pending'), tool('done')], ['pending']],
    [[human, ai('done'), tool('done'), { type: 'ai', content: '回答中' }], []],
  ])('思考/单工具/并行部分完成/工具已完成：%j', (history, expected) => {
    expect(getInterruptedToolMessages(history as any[]).map((message) => message.tool_call_id)).toEqual(expected);
  });
  it('只处理最后用户回合最新批次，不修补早期回合或较早批次', () => {
    const history = [human, ai('old-turn'), human, ai('old-batch'), ai('new-batch')];
    expect(getInterruptedToolMessages(history).map((message) => message.tool_call_id)).toEqual(['new-batch']);
    expect(getInterruptedToolMessages([...history, human])).toEqual([]);
    expect(getInterruptedToolMessages([ai('no-user')])).toEqual([]);
  });
  it('协议正文不展示、不作为成功证据，已有完成工具保留', () => {
    const history = [human, ai('done', 'pending'), tool('done')];
    const protocol = getInterruptedToolMessages(history);
    expect(protocol[0].content).toBe('该工具调用在完成前被用户中止，未获得结果。');
    const projected = projectLangGraphMessages([...history, ...protocol, { type: 'human', content: '继续' }], { isRunActive: true });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(protocol[0].content);
    expect(serialized).not.toContain('lma_protocol');
    expect(projected[1].parts).toMatchObject([
      { type: 'tool', toolCall: { id: 'done', status: 'success', data: { message: '真实证据' } } },
      { type: 'tool', toolCall: { id: 'pending', status: 'cancelled' } },
    ]);
    expect(getInterruptedToolMessages([...history, ...protocol])).toEqual([]);
  });
  it('无效批次显式拒绝，不能裁剪或捏造call id', () => {
    expect(() => getInterruptedToolMessages([human, ai('duplicate', 'duplicate')])).toThrow('工具批次协议无效');
    expect(() => getInterruptedToolMessages([human, ai('')])).toThrow('工具批次协议无效');
  });
  const fakeClient = (status = 'interrupted') => ({ threads: { get: vi.fn().mockResolvedValue({ status: 'idle' }),
    getState: vi.fn().mockResolvedValue({ values: { messages: [human, ai('pending')] } }), updateState: vi.fn() },
    runs: { list: vi.fn().mockResolvedValue([{ status }]), cancel: vi.fn() } });
  it('重新加载后只读Server确认最新Run，协议消息与用户输入合并，无checkpoint写入', async () => {
    const client = fakeClient();
    const input = await prepareThreadInput(client as unknown as Client, 'thread-a', '继续');
    expect(input).toMatchObject([{ type: 'tool', tool_call_id: 'pending', status: 'error' }, { type: 'human', content: '继续' }]);
    expect(client.runs.list).toHaveBeenCalledWith('thread-a', { limit: 1 });
    expect(client.threads.updateState).not.toHaveBeenCalled(); expect(client.runs.cancel).not.toHaveBeenCalled();
  });
  it.each(['success', 'error'])('最新Run为%s时不修补历史', async (status) => {
    const client = fakeClient(status);
    expect(await prepareThreadInput(client as unknown as Client, 'thread-a', '继续')).toEqual([{ type: 'human', content: '继续' }]);
  });
  it.each(['pending', 'running'])('最新Run为%s时拒绝续聊，即使Thread状态尚未同步', async (status) => {
    await expect(prepareThreadInput(fakeClient(status) as unknown as Client, 'thread-a', '继续')).rejects.toThrow('会话仍在运行');
  });
  it('busy、历史读取失败或历史缺失时显式失败，不使用本地消息兜底', async () => {
    const client = fakeClient();
    client.threads.get.mockResolvedValue({ status: 'busy' });
    await expect(prepareThreadInput(client as unknown as Client, 'thread-a', '继续')).rejects.toThrow('会话仍在运行');
    expect(client.threads.getState).not.toHaveBeenCalled();
    client.threads.get.mockResolvedValue({ status: 'idle' });
    client.threads.getState.mockResolvedValue({ values: {} });
    await expect(prepareThreadInput(client as unknown as Client, 'thread-a', '继续')).rejects.toThrow('服务端会话历史不可用');
    client.threads.getState.mockRejectedValue(new Error('fetch failed'));
    await expect(prepareThreadInput(client as unknown as Client, 'thread-a', '继续')).rejects.toThrow('fetch failed');
  });
});
