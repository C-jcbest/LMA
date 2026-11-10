import { afterEach, expect, it, vi } from 'vitest';
import { createLmaClient } from '../src/services/api';

afterEach(() => vi.restoreAllMocks());

it('SSE 按官方解码器处理分块中文、values 和工具 artifact', async () => {
  const artifact = { version: 1, kind: 'station_list', status: 'success', data: { total: 0, stations: [] } };
  const wire = `event: values\ndata: ${JSON.stringify({ messages: [{ type: 'tool', content: '暂无站点', artifact }] })}\n\n`;
  const bytes = new TextEncoder().encode(wire);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  })));
  const events = [];
  for await (const event of createLmaClient('/api').streamRun('session', [], { signal: new AbortController().signal })) {
    events.push(event);
  }
  expect(events).toEqual([{ event: 'values', data: { messages: [{ type: 'tool', content: '暂无站点', artifact }] } }]);
});

it('DELETE 204 不解析空 JSON，也不在网络错误后自动重发', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  const client = createLmaClient('/api');
  await expect(client.deleteSession('session')).resolves.toBeUndefined();
  fetchSpy.mockRejectedValue(new TypeError('network response lost'));
  await expect(client.deleteSession('session')).rejects.toThrow('network response lost');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('HTTP 失败显示服务端受控原因，不启动第二套重试', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify({ detail: '当前会话仍在运行，请停止后再操作。' }), { status: 409 },
  ));
  await expect(createLmaClient('/api').deleteSession('session')).rejects.toThrow('当前会话仍在运行');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
