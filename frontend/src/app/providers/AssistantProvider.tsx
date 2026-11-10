import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLangGraphRuntime } from '@assistant-ui/react-langgraph';
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import type { LmaClient } from '@/services/api';
import { createSessionListAdapter } from '@/lib/session-list-adapter';
import { FocusStationContext, LmaClientContext } from './LmaClientContext';

const getUrlThreadId = () => new URL(window.location.href).searchParams.get('threadId') || undefined;

type RecoveryError = 'history' | 'run' | null;
const RequestedSessionContext = createContext<string | undefined>(undefined);

/** URL 选中的历史会话尚未接管 Runtime 时，不能向临时的新会话发送。 */
export function useConversationLoading() {
  const requestedId = useContext(RequestedSessionContext);
  return useAuiState((state) => {
    const selected = state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId);
    return state.thread.isLoading || state.threads.isLoading
      || Boolean(requestedId && selected?.remoteId !== requestedId);
  });
}

function RecoveryNotice({ error, runtime }: { error: RecoveryError; runtime: ReturnType<typeof useLangGraphRuntime> }) {
  const messages = useAuiState((state) => state.thread.messages);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const lastMessage = messages.at(-1);
  const hasMessageError = lastMessage?.role === 'assistant'
    && lastMessage.status?.type === 'incomplete'
    && lastMessage.status.reason === 'error';
  if (!error || (error === 'run' && (hasMessageError || isRunning))) {
    return null;
  }
  const retry = () => {
    const question = [...messages].reverse().find((message) => message.role === 'user');
    if (error === 'run' && question) {
      runtime.thread.startRun({ parentId: question.id });
      return;
    }
    window.location.reload();
  };
  return (
    <div role="alert" className="fixed inset-x-4 top-2 z-50 flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
      <span>{error === 'history' ? '会话内容尚未载入。' : '本次回答未完成。'}</span>
      <button type="button" className="shrink-0 underline underline-offset-4" onClick={retry}>
        {error === 'history' ? '重新载入' : '重试'}
      </button>
    </div>
  );
}

export function AssistantProvider({ client, children }: { client: LmaClient; children: ReactNode }) {
  const [threadId, setThreadId] = useState(getUrlThreadId);
  const [error, setError] = useState<RecoveryError>(null);
  useEffect(() => {
    const onPopState = () => setThreadId(getUrlThreadId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    setError(null);
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

  const focusStationRef = useRef<string | null>(null);
  const setFocusStation = useCallback((stationName: string | null) => {
    focusStationRef.current = stationName;
  }, []);

  const adapter = useMemo(() => createSessionListAdapter(client), [client]);
  const runtime = useLangGraphRuntime({
    threadId,
    onThreadIdChange: handleThreadIdChange,
    unstable_threadListAdapter: adapter,
    unstable_allowCancellation: true,
    async *stream(messages, config) {
      setError(null);
      try {
        const { externalId } = await config.initialize();
        if (!externalId) throw new Error('会话尚未创建。');
        yield* client.streamRun(externalId, messages, {
          checkpointId: config.checkpointId,
          focusStation: focusStationRef.current ?? undefined,
          signal: config.abortSignal,
        });
      } catch (reason) {
        if (!config.abortSignal.aborted) {
          setError('run');
        }
        throw reason;
      }
    },
    async load(id, config) {
      setError(null);
      try {
        const state = await client.getState(id, config?.signal);
        return { messages: state.values.messages };
      } catch (reason) {
        if (!config?.signal.aborted) {
          setError('history');
        }
        throw reason;
      }
    },
    getCheckpointId: (id, messages) => client.findCheckpoint(id, messages),
    eventHandlers: {
      onError: () => setError('run'),
      // 子图错误可由主调查恢复，不将内部尝试提升为全局故障。
      onSubgraphError: () => setError(null),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RecoveryNotice error={error} runtime={runtime} />
      <LmaClientContext.Provider value={client}>
        <RequestedSessionContext.Provider value={threadId}>
          <FocusStationContext.Provider value={setFocusStation}>{children}</FocusStationContext.Provider>
        </RequestedSessionContext.Provider>
      </LmaClientContext.Provider>
    </AssistantRuntimeProvider>
  );
}
