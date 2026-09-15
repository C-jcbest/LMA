import { afterEach, expect, it, vi } from 'vitest';
import { createLangGraphClient, getSessions, getSessionStatuses, mergeThreadSessions, projectThreadSessions } from '../src/services/api';

afterEach(() => vi.restoreAllMocks());
const rawThread = (index: number, graph = 'lma-agent') => ({ thread_id: `thread-${index}`, metadata: { graph_id: graph, name: `会话${index}` },
  created_at: '2026-09-01T00:00:00Z', updated_at: new Date(Date.UTC(2026, 8, 15, 0, index)).toISOString(), status: 'idle' });

it('真实 SDK 按 graph 归属与更新时间分页，125个主会话完整、辅助会话排除', async () => {
  const dataset = [...Array.from({ length: 125 }, (_, index) => rawThread(index)), rawThread(126, 'session-title'), rawThread(127, 'other-agent')];
  const queries: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, options: any) => {
    const query = JSON.parse(options.body); queries.push(query);
    const matching = dataset.filter((thread) => thread.metadata.graph_id === query.metadata.graph_id)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return new Response(JSON.stringify(matching.slice(query.offset, query.offset + query.limit)), { headers: { 'content-type': 'application/json' } });
  });
  const client = createLangGraphClient('http://test-server:2024');
  let offset = 0; let more = true; let merged: ReturnType<typeof projectThreadSessions> = [];
  while (more) {
    const page = await getSessions(client, offset);
    merged = mergeThreadSessions(merged, page.sessions); offset = page.nextOffset; more = page.hasMore;
  }
  expect(merged).toHaveLength(125);
  expect(new Set(merged.map((session) => session.thread_id)).size).toBe(125);
  expect(merged[0].thread_id).toBe('thread-124'); expect(merged[124].thread_id).toBe('thread-0');
  expect(queries.map((query) => query.offset)).toEqual([0, 20, 40, 60, 80, 100, 120]);
  expect(queries.every((query) => query.metadata.graph_id === 'lma-agent' && query.sort_by === 'updated_at' && query.sort_order === 'desc')).toBe(true);
  expect(queries[0].select).toEqual(['thread_id', 'created_at', 'updated_at', 'metadata', 'status']);
});

it('相邻页重叠按ID去重，旧更新时间不能覆盖新证据，更新时间决定排序', () => {
  const older = projectThreadSessions([rawThread(1)])[0];
  const newer = { ...older, name: '更新标题', updated_at: '2026-09-16T00:00:00Z' };
  const other = projectThreadSessions([rawThread(2)])[0];
  expect(mergeThreadSessions([newer, other], [older])).toEqual([newer, other]);
});

it('busy刷新只查目标ID且不带busy过滤，能取得idle；缺失ID明确失败', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([rawThread(1)]), { headers: { 'content-type': 'application/json' } }));
  const client = createLangGraphClient('http://test-server:2024');
  expect(await getSessionStatuses(client, ['thread-1'])).toMatchObject([{ status: 'idle' }]);
  const query = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
  expect(query.ids).toEqual(['thread-1']); expect(query.metadata).toEqual({ graph_id: 'lma-agent' });
  expect(query).not.toHaveProperty('status'); expect(query.select).not.toContain('values');
  fetchSpy.mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }));
  await expect(getSessionStatuses(client, ['thread-1'])).rejects.toThrow('部分会话未返回运行状态');
});

it('主会话缺失或无效updated_at显式失败，不猜测排序时间', () => {
  expect(() => projectThreadSessions([{ ...rawThread(1), updated_at: undefined }])).toThrow('会话缺少有效更新时间');
  expect(() => projectThreadSessions([{ ...rawThread(1), updated_at: 'invalid' }])).toThrow('会话缺少有效更新时间');
});
