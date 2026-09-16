import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStream, useToolCalls } from '@langchain/react';
import type { Client } from '@langchain/langgraph-sdk';
import { Sidebar, SidebarSession, ServerReachability } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import { ContextUsage } from './components/ContextUsageIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OptimisticMessageStatus } from './components/OptimisticMessageStatus';
import { ToastContainer, useToast } from './components/Toast';
import { rehydrateThread } from './services/streamCompat';
import {
  LMA_ASSISTANT_ID,
  createLangGraphClient,
  ThreadSession,
  Message,
  removeIncompleteToolCallMessages,
  generateSessionTitle,
  getSessions,
  getBusySessions,
  mergeSessions,
  getStoredApiUrl,
  projectLangGraphMessages,
  projectThreadSessions,
  renameSession,
} from './services/api';

interface LmaState {
  messages: unknown[];
  recommendations?: string[];
  recommendations_error?: string;
  business_time?: string;
  context_usage?: ContextUsage;
}

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isListLoading, setIsListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const nextOffsetRef = useRef(0);
  const listPendingRef = useRef(false);
  // URL 仅记录选择态；消息和运行状态始终由官方 SDK 恢复。
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => new URL(window.location.href).searchParams.get('threadId')
  );
  const selectedThreadRef = useRef(activeThreadId);
  selectedThreadRef.current = activeThreadId;
  const isNewSessionDraft = activeThreadId === null;
  const selectThread = useCallback((id: string | null, mode: 'push' | 'replace' = 'push') => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('threadId') === id) return;
    if (id) url.searchParams.set('threadId', id);
    else url.searchParams.delete('threadId');
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    selectedThreadRef.current = id;
    setActiveThreadId(id);
  }, []);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [serverReachability, setServerReachability] = useState<ServerReachability>('unknown');
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  // 官方 Hook 和所有辅助请求共用实例；业务请求不再重新读取 localStorage。
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);
  const currentClientRef = useRef(client);
  currentClientRef.current = client;

  // 官方 stream.isLoading 已覆盖 Run 启动与执行；本地仅保留 Stop 后的 checkpoint 清理过渡态，按 Thread 归属精确隔离。
  const [stopReconcilingThreadId, setStopReconcilingThreadId] = useState<string | null>(null);
  const stopReconcilingThreadIdRef = useRef<string | null>(null);
  const stopReconciling = Boolean(activeThreadId && stopReconcilingThreadId === activeThreadId);
  const isSubmittingRef = useRef(false);

  // 分层错误交互模型（彻底替代全局 submissionError，按 Thread 精准隔离）
  const { toasts, showToast, dismissToast } = useToast();
  const [runError, setRunError] = useState<{ threadId: string } | null>(null);
  const [hydrationError, setHydrationError] = useState<{ threadId: string } | null>(null);
  const [stopError, setStopError] = useState<{ threadId: string; message: string; action: 'retry_stop' | 'resync_cleanup' | 'refresh' } | null>(null);

  const visibleRunError = Boolean(runError && runError.threadId === activeThreadId);
  const visibleHydrationError = Boolean(hydrationError && hydrationError.threadId === activeThreadId);
  const visibleStopError = stopError?.threadId === activeThreadId ? stopError : null;

  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending'>>({});
  const [newThreadOrder, setNewThreadOrder] = useState<string[]>([]);
  const titleJobsRef = useRef(new Map<string, { text: string; client: Client; creationNotified: boolean; titleStarted?: boolean }>());
  const activeRunRef = useRef<{ threadId: string; runId: string } | null>(null);
  const activeSubmissionRef = useRef<{
    client: Client;
    threadId: string | null;
    runId?: string;
    stopped: boolean;
  } | null>(null);
  const firstInputRef = useRef<{ text: string; client: Client } | null>(null);
  const sessionRequestRef = useRef(0);
  const deletingThreadsRef = useRef(new Set<string>());
  const [deletingThreadIds, setDeletingThreadIds] = useState<string[]>([]);
  const clearTitleView = useCallback((id: string) => {
    setTitleViews((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const loadSessions = useCallback(async (append = false) => {
    if (currentClientRef.current !== client || deletingThreadsRef.current.size) return;
    if (append && listPendingRef.current) return;
    listPendingRef.current = true;
    setIsListLoading(true);
    setListError('');
    const request = ++sessionRequestRef.current;
    try {
      // 事件刷新重新获取已加载范围，避免删除/更新后 offset 位移；空闲时不轮询全列表。
      let res = await getSessions(client, append ? nextOffsetRef.current : 0);
      let rows = res.sessions;
      const loadedEnd = nextOffsetRef.current;
      while (!append && res.hasMore && res.nextOffset < loadedEnd) {
        res = await getSessions(client, res.nextOffset);
        rows = mergeSessions(rows, res.sessions);
      }
      if (request !== sessionRequestRef.current) return;
      setServerReachability('reachable');
      setSessions((current) => mergeSessions(append ? current : [], rows));
      nextOffsetRef.current = res.nextOffset;
      setHasMoreSessions(res.hasMore);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
      setListError('会话列表加载失败，请重试');
      // 仅当探测 Assistant 也无法连接时才定性为服务不可达，避免列表接口单点错误误报全局不可达
      client?.assistants?.get?.(LMA_ASSISTANT_ID)?.catch(() => {
        if (request === sessionRequestRef.current) setServerReachability('unreachable');
      });
    } finally {
      if (request === sessionRequestRef.current) {
        listPendingRef.current = false;
        setIsListLoading(false);
      }
    }
  }, [client]);

  const onThreadId = useCallback((id: string) => {
    if (currentClientRef.current !== client) return;
    selectThread(id, 'replace');
    if (activeSubmissionRef.current?.client === client) activeSubmissionRef.current.threadId = id;
    const input = firstInputRef.current;
    if (input) {
      setNewThreadOrder((ids) => [id, ...ids.filter((item) => item !== id)]);
      titleJobsRef.current.set(id, { ...input, creationNotified: false });
      setTitleViews((current) => ({ ...current, [id]: 'pending' }));
    }
  }, [selectThread, client]);

  const onCreated = useCallback(({ runId }: { runId: string }) => {
    const submission = activeSubmissionRef.current?.client === client ? activeSubmissionRef.current : null;
    if (submission?.threadId) {
      activeRunRef.current = { threadId: submission.threadId, runId };
      submission.runId = runId;
    }
    // 官方回调只有 runId。用服务端 Run 确认归属，迟到回调和切换会话不会串标题。
    for (const [id, job] of titleJobsRef.current) {
      job.creationNotified = true;
      void (async () => {
        try {
          await job.client.runs.get(id, runId);
        } catch (error) {
          job.creationNotified = false;
          console.warn('title run ownership check error:', error);
          return;
        }
        if (titleJobsRef.current.get(id) !== job || job.titleStarted) return;
        job.titleStarted = true;
        // 在 Run 已被接受时开始，绝不等待主 Agent 完成。
        const titlePromise = generateSessionTitle(job.client, job.text).catch((error) => {
          console.warn('generate session title error:', error);
          return '新会话';
        });
        try {
          const title = await titlePromise;
          if (titleJobsRef.current.get(id) !== job) return;
          const current = await job.client.threads.get(id);
          if (titleJobsRef.current.get(id) !== job) return;
          // 只更新尚未命名的会话，保留服务端已确认的手动命名。
          const thread = current.metadata?.name
            ? current
            : await job.client.threads.update(id, { metadata: { name: title } });
          if (titleJobsRef.current.get(id) !== job) return;
          const confirmed = projectThreadSessions([thread]);
          ++sessionRequestRef.current;
          setSessions((items) => mergeSessions(items, confirmed));
          clearTitleView(id);
          void loadSessions();
        } catch (error) {
          // 辅助能力静默降级：记录日志，清掉 title skeleton，由 loadSessions() 从权威服务端列表同步，绝不伪造 created_at
          console.warn('session title metadata save error:', error);
          if (titleJobsRef.current.get(id) === job) {
            clearTitleView(id);
            void loadSessions();
          }
        } finally {
          if (titleJobsRef.current.get(id) === job) titleJobsRef.current.delete(id);
        }
      })();
    }
  }, [clearTitleView, loadSessions, client]);

  const stream = useStream<LmaState>({
    assistantId: LMA_ASSISTANT_ID,
    client,
    threadId: activeThreadId,
    messagesKey: 'messages',
    optimistic: true,
    onThreadId,
    onCreated,
    onCompleted: ({ runId, reason }: { runId?: string; reason?: string }) => {
      if (!runId || activeRunRef.current?.runId === runId) activeRunRef.current = null;
      if (reason === 'success') {
        setRunError(null);
      }
    },
  });
  const toolCalls = useToolCalls(stream);
  const hasRunningTool = toolCalls.some((toolCall) => toolCall.status === 'running');

  // 监听 Thread hydration 状态（按 Thread 精确隔离）
  useEffect(() => {
    if (!activeThreadId) {
      setHydrationError(null);
      return;
    }
    const targetThreadId = activeThreadId;
    let active = true;
    stream.hydrationPromise?.then(
      () => {
        if (active && selectedThreadRef.current === targetThreadId) {
          setHydrationError((prev) => (prev?.threadId === targetThreadId ? null : prev));
        }
      },
      (error) => {
        if (active && selectedThreadRef.current === targetThreadId) {
          console.warn('thread hydration error:', error);
          setHydrationError({ threadId: targetThreadId });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [activeThreadId, stream.hydrationPromise]);

  const handleReloadThread = async () => {
    if (!activeThreadId) return;
    const targetThreadId = activeThreadId;
    setHydrationError((prev) => (prev?.threadId === targetThreadId ? null : prev));
    try {
      await rehydrateThread(stream, targetThreadId);
    } catch (error) {
      console.warn('reload thread failed:', error);
      if (selectedThreadRef.current === targetThreadId) {
        setHydrationError({ threadId: targetThreadId });
      }
    }
  };

  useEffect(() => {
    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId');
      if (selectedThreadRef.current === id) return;
      // 导航只断开订阅，服务端 Run 继续；历史由 SDK 根据 URL ID 恢复。
      stream.disconnect();
      setRunError(null);
      setStopError(null);
      selectedThreadRef.current = id;
      setActiveThreadId(id);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [stream.disconnect]);

  const sidebarSessions = useMemo<SidebarSession[]>(() => {
    const items: SidebarSession[] = sessions.map((session) => ({ ...session }));
    for (const [id, phase] of Object.entries(titleViews)) {
      const index = items.findIndex((session) => session.thread_id === id);
      const display = {
        ...(index >= 0 ? items[index] : { thread_id: id }),
        name: phase === 'pending' ? '' : items[index]?.name || '新会话',
        titlePending: phase === 'pending',
      };
      if (index >= 0) items[index] = display;
      else items.unshift(display);
    }
    const order = new Map(newThreadOrder.filter((id) => titleViews[id]).map((id, index) => [id, index]));
    return items.sort((a, b) => (order.get(a.thread_id) ?? newThreadOrder.length) - (order.get(b.thread_id) ?? newThreadOrder.length));
  }, [sessions, titleViews, newThreadOrder]);

  useEffect(() => {
    void loadSessions();
    return () => {
      ++sessionRequestRef.current;
    };
  }, [loadSessions]);

  const busyIds = sessions.filter((item) => item.status === 'busy').map((item) => item.thread_id).sort().join(',');
  useEffect(() => {
    if (!busyIds) return;
    let disposed = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending || deletingThreadsRef.current.size || listPendingRef.current) return;
      pending = true;
      const request = sessionRequestRef.current;
      void getBusySessions(client, busyIds.split(',')).then((rows) => {
        if (disposed || request !== sessionRequestRef.current || currentClientRef.current !== client) return;
        setSessions((current) => mergeSessions(current, rows));
        setListError('');
      }).catch((error) => {
        if (disposed || request !== sessionRequestRef.current) return;
        console.warn('busy session refresh error:', error);
        setListError('会话状态刷新失败，请重试');
      }).finally(() => { pending = false; });
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, busyIds]);

  const messages = useMemo<Message[]>(() => {
    if (isNewSessionDraft) return [];
    const projected = projectLangGraphMessages((stream.messages || []) as unknown[]);
    return projected;
  }, [stream.messages, isNewSessionDraft]);

  const recommendations = useMemo(
    () =>
      Array.isArray(stream.values?.recommendations)
        ? stream.values.recommendations.filter((item): item is string => typeof item === 'string').slice(0, 3)
        : [],
    [stream.values?.recommendations]
  );
  const contextSummary = useMemo(() => {
    if (isNewSessionDraft) return '';
    const summary = (stream.values?.messages || []).find((message: any) =>
      message?.additional_kwargs?.lc_source === 'summarization'
    ) as { content?: unknown } | undefined;
    return typeof summary?.content === 'string' ? summary.content : '';
  }, [stream.values?.messages, isNewSessionDraft]);
  const recommendationError =
    typeof stream.values?.recommendations_error === 'string'
      ? stream.values.recommendations_error
      : '';
  useEffect(() => {
    if (recommendationError) {
      console.warn('recommendations failed, downgraded silently:', recommendationError);
    }
  }, [recommendationError]);
  const busyThreadIds = useMemo(() => {
    const busy = sessions
      .filter((session) => session.thread_id !== activeThreadId && session.status === 'busy')
      .map((session) => session.thread_id);
    if (stream.isLoading && activeThreadId && !busy.includes(activeThreadId)) busy.push(activeThreadId);
    return busy;
  }, [sessions, stream.isLoading, activeThreadId]);

  const handleSelectSession = (session: Pick<ThreadSession, 'thread_id'>) => {
    stream.disconnect();
    setRunError(null);
    setStopError(null);
    selectThread(session.thread_id);
  };

  const handleCreateSession = () => {
    stream.disconnect();
    setRunError(null);
    setStopError(null);
    selectThread(null);
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      await renameSession(client, sessionId, newName);
      if (currentClientRef.current !== client) return;
      setSessions((current) =>
        current.map((session) =>
          session.thread_id === sessionId ? { ...session, name: newName } : session
        )
      );
      void loadSessions();
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('rename session error:', error);
      showToast('重命名失败，请稍后重试', 'error');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    // 同步防重，并作废删除之前的列表请求；DELETE 未确认时暂停轮询写回。
    if (deletingThreadsRef.current.has(sessionId)) return;
    deletingThreadsRef.current.add(sessionId);
    setDeletingThreadIds([...deletingThreadsRef.current]);
    ++sessionRequestRef.current;
    let stage = 'disconnect';
    console.info('delete session started:', { threadId: sessionId });
    try {
      // 删除前先断开此 Thread 的订阅，避免删除后取消/查询已不存在的会话。
      if (selectedThreadRef.current === sessionId) await stream.disconnect();
      stage = 'delete';
      await stream.client.threads.delete(sessionId);
      if (currentClientRef.current !== client) return;
      console.info('delete session confirmed:', { threadId: sessionId });
      stage = 'display';
      ++sessionRequestRef.current;
      setNewThreadOrder((ids) => ids.filter((id) => id !== sessionId));
      clearTitleView(sessionId);
      titleJobsRef.current.delete(sessionId);
      setSessions((current) => current.filter((session) => session.thread_id !== sessionId));
      if (selectedThreadRef.current === sessionId) selectThread(null, 'replace');
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('delete session error:', error);
      const status = error && typeof error === 'object' && 'status' in error ? (error as any).status : undefined;
      console.warn('delete session failed stage:', { threadId: sessionId, stage, status });
      showToast(
        status === 404
          ? '此会话已不存在'
          : status === 409
            ? '会话正在运行，请停止后再删除'
            : '删除失败，请稍后重试',
        'error'
      );
    } finally {
      if (currentClientRef.current === client) {
        deletingThreadsRef.current.delete(sessionId);
        setDeletingThreadIds([...deletingThreadsRef.current]);
        void loadSessions();
      }
    }
  };

  const handleSendMessage = async (userText: string) => {
    const text = userText.trim();
    if (!text || stream.isThreadLoading || stream.isLoading || stopReconciling || isSubmittingRef.current) return;
    // 在第一个 await 前同步上锁，防止快速回车/双击同时创建两个 Thread。
    isSubmittingRef.current = true;
    setRunError(null);
    setStopError(null);

    const isFirstMessage = activeThreadId === null;
    const submission = { client, threadId: activeThreadId, stopped: false, runId: undefined as string | undefined };
    activeSubmissionRef.current = submission;
    if (isFirstMessage) firstInputRef.current = { text, client: stream.client };
    let recoveryPromise: Promise<void> | null = null;
    const reconcileRunError = async (error: unknown) => {
      if (submission.stopped || currentClientRef.current !== submission.client) return;
      const threadId = submission.threadId;
      const runId = submission.runId;
      if (!threadId || !runId) {
        // 未创建 Run 的情况由 optimistic failed 处理，不产生 assistant 错误卡
        return;
      }

      try {
        let run = await submission.client.runs.get(threadId, runId);
        if (run.status === 'pending' || run.status === 'running') {
          // 流连接异常不等于服务端 Run 失败。等待已确认的同一 Run 收敛后再判断，
          // 不重试、不新建 Run，也不把旧 checkpoint 当成成功结果。
          try {
            await submission.client.runs.join(threadId, runId);
          } catch (joinError) {
            console.warn('join submitted run after stream error failed:', joinError);
          }
          run = await submission.client.runs.get(threadId, runId);
        }
        if (submission.stopped || currentClientRef.current !== submission.client) return;
        if (run.status === 'success') {
          await rehydrateThread(stream, threadId);
          if (!submission.stopped && currentClientRef.current === submission.client) {
            setRunError((prev) => (prev?.threadId === threadId ? null : prev));
          }
          return;
        }
        if (run.status === 'interrupted' && submission.stopped) return;
        console.warn('submitted run failed', {
          threadId,
          runId,
          status: run?.status,
          error,
        });
        setRunError({ threadId });
      } catch (reconcileError) {
        console.warn('reconcile submitted run error:', reconcileError);
        if (!submission.stopped && currentClientRef.current === submission.client) {
          setRunError({ threadId });
        }
      }
    };
    try {
      // 乐观消息由官方 SDK 注入并与 checkpoint 协调，不在应用中复制消息。
      await stream.submit(
        { messages: [{ type: 'human', content: text }] },
        {
          multitaskStrategy: 'reject',
          onError: (error) => {
            if (submission.stopped || currentClientRef.current !== submission.client) return;
            recoveryPromise ??= reconcileRunError(error);
            for (const [id, job] of titleJobsRef.current) {
              if (!job.creationNotified) {
                clearTitleView(id);
                titleJobsRef.current.delete(id);
              }
            }
          },
        }
      );
      if (recoveryPromise) await recoveryPromise;
    } catch (error) {
      if (submission.stopped || currentClientRef.current !== submission.client) return;
      if (recoveryPromise) await recoveryPromise;
      else if (submission.runId) {
        setRunError({ threadId: submission.threadId || '' });
      }
    } finally {
      if (currentClientRef.current === client) {
        firstInputRef.current = null;
        if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
        isSubmittingRef.current = false;
        void loadSessions();
      }
    }
  };

  // 重新生成：遵循官方 Retry an AI turn 规范，通过 parentCheckpointId 分叉，并重新提交官方 BaseMessage 对象
  const handleRegenerate = async (checkpointId: string, lastHumanMsg: any) => {
    if (stream.isLoading || isSubmittingRef.current || stopReconciling) return;
    const currentThreadId = activeThreadId;
    if (!currentThreadId || !checkpointId) return;

    // 从 stream.messages 中寻找该轮次最后一条 HumanMessage（保留其完整属性）
    const lastHuman = [...(stream.messages || [])]
      .reverse()
      .find((m: any) => m.type === 'human' || m.role === 'user') || lastHumanMsg;
    if (!lastHuman) return;

    isSubmittingRef.current = true;
    setRunError((prev) => (prev?.threadId === currentThreadId ? null : prev));
    const submission = { client, threadId: currentThreadId, stopped: false, runId: undefined as string | undefined };
    activeSubmissionRef.current = submission;

    let recoveryPromise: Promise<void> | null = null;
    const reconcileRunError = async (error: unknown) => {
      if (submission.stopped || currentClientRef.current !== submission.client) return;
      const threadId = submission.threadId;
      const runId = submission.runId;
      if (!threadId || !runId) return;
      try {
        let run = await submission.client.runs.get(threadId, runId);
        if (run.status === 'pending' || run.status === 'running') {
          try { await submission.client.runs.join(threadId, runId); } catch {}
          run = await submission.client.runs.get(threadId, runId);
        }
        if (submission.stopped || currentClientRef.current !== submission.client) return;
        if (run.status === 'success') {
          await rehydrateThread(stream, threadId);
          return;
        }
        if (run.status === 'interrupted' && submission.stopped) return;
        console.warn('submitted run failed', {
          threadId,
          runId,
          status: run?.status,
          error,
        });
        setRunError({ threadId });
      } catch (err) {
        console.warn('reconcile regenerate error:', err);
        if (!submission.stopped && currentClientRef.current === submission.client) {
          setRunError({ threadId });
        }
      }
    };

    try {
      await stream.submit(
        { messages: [lastHuman] },
        {
          forkFrom: checkpointId,
          multitaskStrategy: 'reject',
          onError: (error) => {
            if (submission.stopped || currentClientRef.current !== submission.client) return;
            recoveryPromise ??= reconcileRunError(error);
          },
        }
      );
      if (recoveryPromise) await recoveryPromise;
    } catch (error) {
      if (submission.stopped || currentClientRef.current !== submission.client) return;
      if (recoveryPromise) await recoveryPromise;
      else if (submission.runId) {
        setRunError({ threadId: currentThreadId });
      }
    } finally {
      if (currentClientRef.current === client) {
        if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
        isSubmittingRef.current = false;
        void loadSessions();
      }
    }
  };

  const handleStopGeneration = async () => {
    const targetThreadId = activeThreadId;
    const targetClient = client;
    if (!targetThreadId || stopReconcilingThreadIdRef.current === targetThreadId) return;

    stopReconcilingThreadIdRef.current = targetThreadId;
    setStopReconcilingThreadId(targetThreadId);
    if (activeSubmissionRef.current?.threadId === targetThreadId) {
      activeSubmissionRef.current.stopped = true;
    }
    setStopError((prev) => (prev?.threadId === targetThreadId ? null : prev));

    let stage: 'stop' | 'terminal_confirm' | 'cleanup' | 'hydrate' = 'stop';
    try {
      // 1. 发送停止请求：官方 stop 默认只对当前 Run 发出 interrupt cancel；不是 HITL，也没有 resume。
      stage = 'stop';
      await stream.stop({ cancel: true });
      if (selectedThreadRef.current !== targetThreadId || currentClientRef.current !== targetClient) return;

      // 2. 确认 Run 已达到终态 (terminal confirmation)：这是执行 checkpoint cleanup 的绝对前置条件。
      stage = 'terminal_confirm';
      let runId = activeRunRef.current?.threadId === targetThreadId ? activeRunRef.current.runId : undefined;
      if (!runId && typeof targetClient?.runs?.list === 'function') {
        // 重新挂载、刷新或离开再切回时本地可能无 activeRunRef；主动查询未完成的 Run
        try {
          const activeRuns = await targetClient.runs.list(targetThreadId, { limit: 5 });
          const inFlight = activeRuns?.find((r: any) => r.status === 'pending' || r.status === 'running');
          if (inFlight) runId = inFlight.run_id;
        } catch (listErr) {
          console.warn('list in-flight runs failed during stop terminal check:', listErr);
          throw listErr;
        }
      }

      if (runId) {
        await targetClient.runs.join(targetThreadId, runId);
        const run = await targetClient.runs.get(targetThreadId, runId);
        if (run.status === 'pending' || run.status === 'running') {
          throw new Error(`Run ${runId} 未能收敛为终态 (当前状态: ${run.status})`);
        }
      }

      // 3. 清理未完成工具调用
      stage = 'cleanup';
      await removeIncompleteToolCallMessages(targetClient, targetThreadId);

      // 4. 重新投影权威 checkpoint
      stage = 'hydrate';
      await rehydrateThread(stream, targetThreadId);
    } catch (error) {
      if (currentClientRef.current !== targetClient) return;
      console.warn('stop generation failed:', { stage, threadId: targetThreadId, error });
      if (stage === 'stop' || stage === 'terminal_confirm') {
        setStopError({ threadId: targetThreadId, message: '停止请求未确认，请重试', action: 'retry_stop' });
      } else if (stage === 'hydrate') {
        setStopError({ threadId: targetThreadId, message: '当前显示可能未更新', action: 'refresh' });
      } else {
        setStopError({ threadId: targetThreadId, message: '会话记录尚未同步', action: 'resync_cleanup' });
      }
    } finally {
      if (stopReconcilingThreadIdRef.current === targetThreadId) {
        stopReconcilingThreadIdRef.current = null;
      }
      setStopReconcilingThreadId((prev) => (prev === targetThreadId ? null : prev));
      if (currentClientRef.current === targetClient) {
        await loadSessions();
      }
    }
  };

  const handleCleanupAfterStop = async () => {
    const targetThreadId = activeThreadId;
    const targetClient = client;
    if (!targetThreadId || stopReconcilingThreadIdRef.current === targetThreadId) return;

    stopReconcilingThreadIdRef.current = targetThreadId;
    setStopReconcilingThreadId(targetThreadId);
    setStopError((prev) => (prev?.threadId === targetThreadId ? null : prev));

    let stage: 'cleanup' | 'hydrate' = 'cleanup';
    try {
      stage = 'cleanup';
      await removeIncompleteToolCallMessages(targetClient, targetThreadId);
      stage = 'hydrate';
      await rehydrateThread(stream, targetThreadId);
    } catch (error) {
      if (currentClientRef.current !== targetClient) return;
      console.warn('cleanup after stop failed:', { stage, threadId: targetThreadId, error });
      if (stage === 'hydrate') {
        setStopError({ threadId: targetThreadId, message: '当前显示可能未更新', action: 'refresh' });
      } else {
        setStopError({ threadId: targetThreadId, message: '会话记录尚未同步', action: 'resync_cleanup' });
      }
    } finally {
      if (stopReconcilingThreadIdRef.current === targetThreadId) {
        stopReconcilingThreadIdRef.current = null;
      }
      setStopReconcilingThreadId((prev) => (prev === targetThreadId ? null : prev));
      if (currentClientRef.current === targetClient) {
        await loadSessions();
      }
    }
  };

  const handleRefreshStop = async () => {
    const targetThreadId = activeThreadId;
    if (!targetThreadId) return;
    setStopError((prev) => (prev?.threadId === targetThreadId ? null : prev));
    try {
      await rehydrateThread(stream, targetThreadId);
    } catch (error) {
      console.warn('refresh after stop failed:', { threadId: targetThreadId, error });
      setStopError({ threadId: targetThreadId, message: '当前显示可能未更新', action: 'refresh' });
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      {!isSidebarCollapsed && (
        <Sidebar
          sessions={sidebarSessions}
          activeSessionId={activeThreadId}
          isNewSessionDraft={isNewSessionDraft}
          busyThreadIds={busyThreadIds}
          deletingThreadIds={deletingThreadIds}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateSession}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onToggleCollapse={() => setIsSidebarCollapsed(true)}
          onOpenConfig={() => setIsConfigOpen(true)}
          serverReachability={serverReachability}
          hasMoreSessions={hasMoreSessions}
          isListLoading={isListLoading}
          listError={listError}
          onLoadMore={() => void loadSessions(true)}
          onRefreshSessions={() => void loadSessions()}
        />
      )}

      <ErrorBoundary fallbackTitle="会话界面加载异常" level="window">
        <ChatWindow
          stream={stream}
          messages={messages}
          contextSummary={contextSummary}
          contextUsage={isNewSessionDraft ? undefined : stream.values?.context_usage}
          onSendMessage={handleSendMessage}
          threadLoading={stream.isThreadLoading}
          runActive={stream.isLoading}
          stopReconciling={stopReconciling}
          hasRunningTool={hasRunningTool}
          renderOptimisticStatus={(messageId, content) => (
            <OptimisticMessageStatus
              stream={stream}
              messageId={messageId}
              onRetry={() => content && handleSendMessage(content)}
            />
          )}
          recommendations={recommendations}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={() => setIsSidebarCollapsed(false)}
          isNewSessionDraft={isNewSessionDraft}
          onStopGeneration={() => void handleStopGeneration()}
          runError={visibleRunError}
          onRegenerate={(checkpointId, message) => void handleRegenerate(checkpointId, message)}
          onDismissRunError={() => setRunError((prev) => (prev?.threadId === activeThreadId ? null : prev))}
          hydrationError={visibleHydrationError}
          onReloadThread={() => void handleReloadThread()}
          onDismissHydrationError={() => setHydrationError((prev) => (prev?.threadId === activeThreadId ? null : prev))}
          stopError={visibleStopError}
          onRetryStop={() => void handleStopGeneration()}
          onResyncCleanup={() => void handleCleanupAfterStop()}
          onRefreshStop={() => void handleRefreshStop()}
          onDismissStopError={() => setStopError((prev) => (prev?.threadId === activeThreadId ? null : prev))}
        />
      </ErrorBoundary>

      <ConfigModal
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        onSaved={() => {
          const nextUrl = getStoredApiUrl();
          if (nextUrl === apiUrl) return;
          stream.disconnect();
          ++sessionRequestRef.current;
          titleJobsRef.current.clear();
          firstInputRef.current = null;
          isSubmittingRef.current = false;
          setStopReconcilingThreadId(null);
          stopReconcilingThreadIdRef.current = null;
          setTitleViews({});
          setNewThreadOrder([]);
          deletingThreadsRef.current.clear();
          setDeletingThreadIds([]);
          setSessions([]);
          nextOffsetRef.current = 0;
          listPendingRef.current = false;
          setHasMoreSessions(false);
          setIsListLoading(false);
          setListError('');
          setServerReachability('unknown');
          setRunError(null);
          setStopError(null);
          setHydrationError(null);
          selectThread(null, 'replace');
          setApiUrl(nextUrl);
        }}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
