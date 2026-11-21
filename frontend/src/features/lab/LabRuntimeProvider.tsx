import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AssistantRuntimeProvider, useAuiState, type RemoteThreadListAdapter } from '@assistant-ui/react';
import { useLangGraphRuntime, useLangGraphSend } from '@assistant-ui/react-langgraph';
import { createAssistantStream } from 'assistant-stream';
import type { LabInspection, LabScope, LmaClient } from '@/services/api';

const THREAD_PARAMETER = 'labThread';
const SCOPE_KEY = 'lmaLabScope';
const JOIN_RUN_KEY = 'lmaLabJoin';

const OpenInspectionContext = createContext<((id: string) => void) | null>(null);

export function useOpenLabInspection() {
  const open = useContext(OpenInspectionContext);
  if (!open) {
    throw new Error('LabRuntimeProvider is required');
  }
  return open;
}

const readThreadId = () => new URL(window.location.href).searchParams.get(THREAD_PARAMETER) || undefined;

export const labRunConfig = (scope: LabScope) => ({ custom: { [SCOPE_KEY]: scope } });

const customOf = (runConfig: unknown): Record<string, unknown> =>
  (runConfig as { custom?: Record<string, unknown> } | undefined)?.custom ?? {};

const scopeOf = (runConfig: unknown) => customOf(runConfig)[SCOPE_KEY] as LabScope | undefined;

const isJoinRun = (runConfig: unknown) => customOf(runConfig)[JOIN_RUN_KEY] === true;

function threadMetadata(inspection: LabInspection) {
  return {
    status: 'regular' as const,
    remoteId: inspection.id,
    externalId: inspection.id,
    title: inspection.label,
    lastMessageAt: new Date(inspection.created_at),
  };
}

function createLabThreadAdapter(client: LmaClient): RemoteThreadListAdapter {
  return {
    async list() {
      return { threads: (await client.listLabInspections()).map(threadMetadata) };
    },
    async initialize() {
      const inspection = await client.createLabInspection();
      return { remoteId: inspection.id, externalId: inspection.id };
    },
    async fetch(id) {
      return threadMetadata(await client.getLabInspection(id));
    },
    async rename() {},
    async archive() {},
    async unarchive() {},
    async delete() {},
    async generateTitle() {
      return createAssistantStream(() => {});
    },
  };
}

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
    void Promise.resolve(send([], { runConfig: { custom: { [JOIN_RUN_KEY]: true } } })).catch(() => {});
  }, [isLoading, isRunning, pendingJoins, remoteId, send]);
  return null;
}

export function LabRuntimeProvider({ client, children }: { client: LmaClient; children: ReactNode }) {
  const [threadId, setThreadId] = useState(readThreadId);
  const pendingJoins = useRef(new Set<string>());
  const [runError, setRunError] = useState<string | null>(null);

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    setRunError(null);
    setThreadId(id);
    const url = new URL(window.location.href);
    if ((url.searchParams.get(THREAD_PARAMETER) || undefined) === id) {
      return;
    }
    if (id) {
      url.searchParams.set(THREAD_PARAMETER, id);
    } else {
      url.searchParams.delete(THREAD_PARAMETER);
    }
    window.history.replaceState(null, '', url);
  }, []);

  const adapter = useMemo(() => createLabThreadAdapter(client), [client]);
  const runtime = useLangGraphRuntime({
    threadId,
    onThreadIdChange: handleThreadIdChange,
    unstable_threadListAdapter: adapter,
    async *stream(messages, config) {
      setRunError(null);
      try {
        const { externalId } = await config.initialize();
        if (!externalId) {
          throw new Error('原型巡检尚未创建。');
        }
        if (isJoinRun(config.runConfig)) {
          yield* client.joinLabRun(externalId, config.abortSignal);
          return;
        }
        const scope = scopeOf(config.runConfig);
        if (!scope) {
          throw new Error('没有选择巡检范围。');
        }
        yield* client.streamLabRun(externalId, messages, scope, config.abortSignal);
      } catch (reason) {
        if (!config.abortSignal.aborted) {
          setRunError(reason instanceof Error ? reason.message : '原型巡检未能启动。');
        }
      }
    },
    async load(id, config) {
      const state = await client.getLabState(id, config?.signal);
      if (state.status === 'running') {
        pendingJoins.current.add(id);
      } else {
        pendingJoins.current.delete(id);
      }
      return { messages: state.values.messages, uiMessages: state.values.ui };
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ActiveRunRejoin pendingJoins={pendingJoins.current} />
      {runError && <p role="alert" className="mb-4 text-sm text-destructive">{runError}</p>}
      <OpenInspectionContext.Provider value={handleThreadIdChange}>{children}</OpenInspectionContext.Provider>
    </AssistantRuntimeProvider>
  );
}
