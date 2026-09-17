import { STREAM_CONTROLLER, type AnyStream } from '@langchain/react';

/**
 * @langchain/react 1.1.0 compatibility adapter
 *
 * 背景：锁定版 @langchain/react 尚无公开的“外部修改 checkpoint 后重新覆盖当前 projection”的 API。
 * 触发条件：仅在 Stop 清理成功后或主动重载 Thread 时调用。
 * 删除条件：SDK 提供公开的 authoritative refresh API 时彻底移除。
 */
export async function rehydrateThread(stream: AnyStream | undefined, threadId: string): Promise<void> {
  if (!stream || !threadId) return;
  const controller = (stream as any)[STREAM_CONTROLLER];
  if (typeof controller?.hydrate === 'function') {
    await controller.hydrate(threadId);
  } else {
    throw new Error('StreamController.hydrate is not available on stream handle');
  }
}
