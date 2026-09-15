import { act, renderHook } from '@testing-library/react';
import { useStream } from '@langchain/react';
import { expect, it, vi } from 'vitest';

it('真实官方 useStream 首次失败：SDK 分配 ID 并提交 run.start，应用不预创建 Thread', async () => {
  const requests: { url: string; body: any }[] = [];
  const fetchStub = vi.fn(async (url: any, options: any) => {
    const body = JSON.parse(options.body || '{}');
    requests.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: body.id, error: { code: 'invalid_params', message: '请求被拒绝' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const onThreadId = vi.fn(); const onError = vi.fn();
  const { result } = renderHook(() => useStream({ assistantId: 'lma-agent', apiUrl: 'http://localhost:2024',
    threadId: null, fetch: fetchStub, callerOptions: { maxRetries: 0 }, onThreadId }));
  let boundId: string | undefined;
  await act(async () => {
    const submission = result.current.submit({ messages: [{ type: 'human', content: '查询站点' }] }, { onError });
    boundId = result.current.getThread()?.threadId;
    await submission;
  });
  expect(onThreadId).toHaveBeenCalledTimes(1);
  const id = onThreadId.mock.calls[0][0];
  expect(boundId).toBe(id);

  expect(requests.some((request) => request.body.method === 'run.start' && request.url.includes(`/threads/${id}/commands`))).toBe(true);
  expect(requests.some((request) => /\/threads\/?$/.test(request.url))).toBe(false);
  expect(onError).toHaveBeenCalled();
});
