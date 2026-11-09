import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLangGraphRuntime } from '@assistant-ui/react-langgraph';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import type { LmaClient } from '@/services/api';
import { createSessionListAdapter } from '@/lib/session-list-adapter';

const getUrlThreadId = () => new URL(window.location.href).searchParams.get('threadId') || undefined;

export function AssistantProvider({ client, children }: { client: LmaClient; children: ReactNode }) {
  const [threadId, setThreadId] = useState(getUrlThreadId);
  const [error, setError] = useState('');
  useEffect(() => {
    const onPopState = () => setThreadId(getUrlThreadId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    setThreadId(id);
    const url = new URL(window.location.href);
    if ((url.searchParams.get('threadId') || undefined) === id) return;
    if (id) {
      url.searchParams.set('threadId', id);
    } else {
      url.searchParams.delete('threadId');
    }
    window.history.pushState(null, '', url);
  }, []);

  const adapter = useMemo(() => createSessionListAdapter(client), [client]);
  const runtime = useLangGraphRuntime({
    threadId,
    onThreadIdChange: handleThreadIdChange,
    unstable_threadListAdapter: adapter,
    unstable_allowCancellation: true,
    async *stream(messages, config) {
      setError('');
      const { externalId } = await config.initialize();
      if (!externalId) throw new Error('会话尚未创建。');
      try {
        yield* client.streamRun(externalId, messages, config.checkpointId, config.abortSignal);
      } catch (reason) {
        if (!config.abortSignal.aborted) {
          setError(reason instanceof Error ? reason.message : '消息发送失败，请稍后重试。');
        }
        throw reason;
      }
    },
    async load(id, config) {
      try {
        const state = await client.getState(id, config?.signal);
        return { messages: state.values.messages };
      } catch (reason) {
        if (!config?.signal.aborted) setError('会话历史读取失败，请刷新后重试。');
        throw reason;
      }
    },
    getCheckpointId: (id, messages) => client.findCheckpoint(id, messages),
    eventHandlers: {
      onError: () => setError('本轮运行失败，已保存完成的步骤，请重新载入会话后重试。'),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {error && <div role="alert" className="fixed inset-x-4 top-2 z-50 rounded-md border bg-background p-3 text-sm text-destructive">{error}</div>}
      {children}
    </AssistantRuntimeProvider>
  );
}
