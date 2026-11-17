import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLangGraphRuntime, useLangGraphSend } from '@assistant-ui/react-langgraph';
import { AssistantRuntimeProvider, useAui, useAuiState } from '@assistant-ui/react';
import type { LmaClient } from '@/services/api';
import { askTargetsOfRunConfig, toAskTargetRecords } from '@/features/monitoring/ask-targets';
import { createSessionListAdapter } from '@/lib/session-list-adapter';
import { FocusStationContext, LmaClientContext } from './LmaClientContext';
import { Button } from '@/components/ui/button';

const getUrlThreadId = () => new URL(window.location.href).searchParams.get('threadId') || undefined;
const getStationThreadId = (stationUuid: string) => {
  const params = new URL(window.location.href).searchParams;
  return params.get('station') === stationUuid ? params.get('stationThread') || undefined : undefined;
};

type RecoveryError = 'history' | 'run' | null;
/** runConfig 标记：本次“运行”只接回服务端仍在进行的调查，不提交新消息。 */
const JOIN_RUN_KEY = 'lmaJoinActiveRun';
const isJoinRun = (runConfig: unknown) =>
  typeof runConfig === 'object' && runConfig !== null && (runConfig as Record<string, unknown>)[JOIN_RUN_KEY] === true;
const RequestedSessionContext = createContext<string | undefined>(undefined);
const RecoveryContext = createContext<{ error: RecoveryError; runtime: ReturnType<typeof useLangGraphRuntime> } | null>(null);
const StationDraftsContext = createContext<Map<string, string> | null>(null);

export interface StationConversationScope {
  stationUuid: string;
  stationName: string;
}

function StationDraft({ stationUuid }: { stationUuid: string }) {
  const aui = useAui();
  const drafts = useContext(StationDraftsContext)!;
  const isLoading = useConversationLoading();
  useEffect(() => {
    if (isLoading) {
      return;
    }
    aui.composer().setText(drafts.get(stationUuid) ?? '');
    return () => {
      drafts.set(stationUuid, aui.composer().getState().text);
    };
  }, [aui, drafts, stationUuid, isLoading]);
  return null;
}

/** 载入会话时服务端调查仍在进行（例如刷新了页面），载入完成后接回它的事件流。 */
function ActiveRunRejoin({ pendingJoins }: { pendingJoins: Set<string> }) {
  const send = useLangGraphSend();
  const remoteId = useAuiState((state) =>
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  useEffect(() => {
    if (isLoading || isRunning || !remoteId || !pendingJoins.has(remoteId)) {
      return;
    }
    pendingJoins.delete(remoteId);
    void Promise.resolve(send([], { runConfig: { [JOIN_RUN_KEY]: true } })).catch(() => {});
  }, [isLoading, isRunning, pendingJoins, remoteId, send]);
  return null;
}

/** URL 选中的历史会话尚未接管 Runtime 时，不能向临时的新会话发送。 */
export function useConversationLoading() {
  const requestedId = useContext(RequestedSessionContext);
  return useAuiState((state) => {
    const selected = state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId);
    return state.thread.isLoading || state.threads.isLoading
      || Boolean(requestedId && selected?.remoteId !== requestedId);
  });
}

export function RecoveryNotice() {
  const recovery = useContext(RecoveryContext);
  const messages = useAuiState((state) => state.thread.messages);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const lastMessage = messages.at(-1);
  const hasMessageError = lastMessage?.role === 'assistant'
    && lastMessage.status?.type === 'incomplete'
    && lastMessage.status.reason === 'error';
  if (!recovery?.error || (recovery.error === 'run' && (hasMessageError || isRunning))) {
    return null;
  }
  const { error, runtime } = recovery;
  const retry = () => {
    const question = [...messages].reverse().find((message) => message.role === 'user');
    if (error === 'run' && question) {
      // 运行失败已由 Provider 显示局部反馈，消费官方 Runtime 返回的拒绝以免成为未处理异常。
      void Promise.resolve(runtime.thread.startRun({ parentId: question.id })).catch(() => {});
      return;
    }
    window.location.reload();
  };
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
      <span>{error === 'history' ? '会话内容尚未载入。' : '本次回答未完成。'}</span>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={retry}>
        {error === 'history' ? '重新载入' : '重试'}
      </Button>
    </div>
  );
}

export function AssistantProvider({ client, children, scope }: { client: LmaClient; children: ReactNode; scope?: StationConversationScope }) {
  const [threadId, setThreadId] = useState(() => scope ? getStationThreadId(scope.stationUuid) : getUrlThreadId());
  const inheritedDrafts = useContext(StationDraftsContext);
  const ownDrafts = useRef(new Map<string, string>());
  const [error, setError] = useState<RecoveryError>(null);
  const pendingJoins = useRef(new Set<string>());
  useEffect(() => {
    const onPopState = () => {
      if (scope && new URL(window.location.href).searchParams.get('station') !== scope.stationUuid) {
        return;
      }
      setThreadId(scope ? getStationThreadId(scope.stationUuid) : getUrlThreadId());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [scope]);

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    setError(null);
    setThreadId(id);
    const url = new URL(window.location.href);
    if (scope && url.searchParams.get('station') !== scope.stationUuid) {
      return;
    }
    const parameter = scope ? 'stationThread' : 'threadId';
    if ((url.searchParams.get(parameter) || undefined) === id) {
      return;
    }
    if (id) {
      url.searchParams.set(parameter, id);
    } else {
      url.searchParams.delete(parameter);
    }
    if (scope) {
      url.searchParams.delete('result');
    }
    window.history.pushState(null, '', url);
  }, [scope]);

  const focusStationRef = useRef<string | null>(null);
  const setFocusStation = useCallback((stationName: string | null) => {
    focusStationRef.current = stationName;
  }, []);

  const adapter = useMemo(() => createSessionListAdapter(client, scope?.stationUuid), [client, scope?.stationUuid]);
  const runtime = useLangGraphRuntime({
    threadId,
    onThreadIdChange: handleThreadIdChange,
    unstable_threadListAdapter: adapter,
    unstable_allowCancellation: true,
    async *stream(messages, config) {
      setError(null);
      let hasAssistantOutput = false;
      try {
        const { externalId } = await config.initialize();
        if (!externalId) throw new Error('会话尚未创建。');
        const events = isJoinRun(config.runConfig)
          ? client.joinRun(externalId, config.abortSignal)
          : client.streamRun(externalId, messages, {
            checkpointId: config.checkpointId,
            focusStation: scope?.stationName ?? focusStationRef.current ?? undefined,
            askTargets: toAskTargetRecords(askTargetsOfRunConfig(config.runConfig)),
            signal: config.abortSignal,
          });
        for await (const event of events) {
          if (event.event.startsWith('messages') && Array.isArray(event.data)) {
            hasAssistantOutput ||= event.data.some((message) => message?.type === 'ai' || message?.type === 'AIMessageChunk');
          }
          if (event.event === 'error' && !hasAssistantOutput) {
            // SDK 的 error 事件会标记最近一条 AI 消息；本轮尚无输出时不能误伤旧回答。
            setError('run');
            continue;
          }
          yield event;
        }
      } catch (reason) {
        if (!config.abortSignal.aborted) {
          setError('run');
          // 与服务端 SSE 错误使用同一公开事件，SDK 保留部分回答并结束运行。
          if (hasAssistantOutput) {
            yield { event: 'error', data: { message: '本次回答未完成。' } };
          }
        }
      }
    },
    async load(id, config) {
      setError(null);
      try {
        const state = await client.getState(id, config?.signal);
        if (state.latest_run?.status === 'running') {
          pendingJoins.current.add(id);
        } else {
          pendingJoins.current.delete(id);
        }
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
      <RecoveryContext.Provider value={{ error, runtime }}>
        <LmaClientContext.Provider value={client}>
          <RequestedSessionContext.Provider value={threadId}>
            <StationDraftsContext.Provider value={inheritedDrafts ?? ownDrafts.current}>
              {scope && <StationDraft stationUuid={scope.stationUuid} />}
              <ActiveRunRejoin pendingJoins={pendingJoins.current} />
              <FocusStationContext.Provider value={setFocusStation}>{children}</FocusStationContext.Provider>
            </StationDraftsContext.Provider>
          </RequestedSessionContext.Provider>
        </LmaClientContext.Provider>
      </RecoveryContext.Provider>
    </AssistantRuntimeProvider>
  );
}
