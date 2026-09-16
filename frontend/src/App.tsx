import { runErrorMessage } from './services/api';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAM_CONTROLLER, useStream, useToolCalls } from '@langchain/react';
import type { Client } from '@langchain/langgraph-sdk';
import { Sidebar, SidebarSession } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import { ContextUsage } from './components/ContextUsageIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OptimisticMessageStatus } from './components/OptimisticMessageStatus';
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
  const [isLiveServer, setIsLiveServer] = useState(false);
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  // 官方 Hook 和所有辅助请求共用实例；业务请求不再重新读取 localStorage。
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);
  const currentClientRef = useRef(client);
  currentClientRef.current = client;
  const [submissionError, setSubmissionError] = useState('');
  // 官方 stream.isLoading 已覆盖 Run 启动与执行；本地仅保留 Stop 后的 checkpoint 清理过渡态。
  const [stopReconciling, setStopReconciling] = useState(false);
  const stopReconcilingRef = useRef(false);
  const isSubmittingRef = useRef(false);

  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending' | 'creation_error' | 'save_error'>>({});
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
      setIsLiveServer(res.isLive);
      setSessions((current) => mergeSessions(append ? current : [], rows));
      nextOffsetRef.current = res.nextOffset;
      setHasMoreSessions(res.hasMore);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
      setIsLiveServer(false);
      setListError('会话列表加载失败，请重试');
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
          console.warn('session title metadata save error:', error);
          if (titleJobsRef.current.get(id) === job) {
            setTitleViews((current) => ({ ...current, [id]: 'save_error' }));
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
      if (reason === 'success' && activeSubmissionRef.current?.runId === runId) setSubmissionError('');
    },
  });
  const toolCalls = useToolCalls(stream);
  const hasRunningTool = toolCalls.some((toolCall) => toolCall.status === 'running');

  useEffect(() => {
    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId');
      if (selectedThreadRef.current === id) return;
      // 导航只断开订阅，服务端 Run 继续；历史由 SDK 根据 URL ID 恢复。
      stream.disconnect();
      setSubmissionError('');
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
        name: phase === 'pending' ? '' : phase === 'creation_error' ? '会话创建未确认' : '会话名称未保存',
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
  const busyThreadIds = useMemo(() => {
    const busy = sessions
      .filter((session) => session.thread_id !== activeThreadId && session.status === 'busy')
      .map((session) => session.thread_id);
    if (stream.isLoading && activeThreadId && !busy.includes(activeThreadId)) busy.push(activeThreadId);
    return busy;
  }, [sessions, stream.isLoading, activeThreadId]);

  const handleSelectSession = (session: Pick<ThreadSession, 'thread_id'>) => {
    stream.disconnect();
    setSubmissionError('');
    selectThread(session.thread_id);
  };

  const handleCreateSession = () => {
    stream.disconnect();
    setSubmissionError('');
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
      setSubmissionError('重命名失败，请稍后重试');
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
      setSubmissionError('');
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('delete session error:', error);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      console.warn('delete session failed stage:', { threadId: sessionId, stage, status });
      setSubmissionError(status === 404
        ? '此会话已不存在'
        : status === 409 ? '会话正在运行，请停止后再删除'
        : '删除失败，请稍后重试');
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
    setSubmissionError('');

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
        setSubmissionError(runErrorMessage(error));
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
          await stream[STREAM_CONTROLLER].hydrate(threadId);
          if (!submission.stopped && currentClientRef.current === submission.client) setSubmissionError('');
          return;
        }
        if (run.status === 'interrupted' && submission.stopped) return;
        setSubmissionError(runErrorMessage(error));
      } catch (reconcileError) {
        console.warn('reconcile submitted run error:', reconcileError);
        if (!submission.stopped && currentClientRef.current === submission.client) {
          setSubmissionError(runErrorMessage(error));
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
                setTitleViews((current) => ({ ...current, [id]: 'creation_error' }));
              }
            }
          },
        }
      );
      if (recoveryPromise) await recoveryPromise;
    } catch (error) {
      if (submission.stopped || currentClientRef.current !== submission.client) return;
      if (recoveryPromise) await recoveryPromise;
      else setSubmissionError(runErrorMessage(error));
    } finally {
      if (currentClientRef.current === client) {
        firstInputRef.current = null;
        if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
        isSubmittingRef.current = false;
        void loadSessions();
      }
    }
  };

  const handleStopGeneration = async () => {
    if (!activeThreadId || stopReconcilingRef.current) return;
    stopReconcilingRef.current = true;
    const activeRun = activeRunRef.current?.threadId === activeThreadId ? activeRunRef.current : null;
    if (activeSubmissionRef.current?.threadId === activeThreadId) activeSubmissionRef.current.stopped = true;
    setSubmissionError('');
    setStopReconciling(true);
    let stage: 'stop' | 'join' | 'cleanup' | 'hydrate' = 'stop';
    try {
      // 官方 stop 默认只对当前 Run 发出 interrupt cancel；不是 HITL，也没有 resume。
      await stream.stop({ cancel: true });
      if (currentClientRef.current !== client) return;
      // stop 的 cancel 请求默认为 interrupt 且不等待；join 只等待这个已知当前 Run 收敛，
      // 不扫描或取消 Thread 中其它 Run。
      stage = 'join';
      if (activeRun) await client.runs.join(activeThreadId, activeRun.runId);
      stage = 'cleanup';
      await removeIncompleteToolCallMessages(client, activeThreadId);
      // 锁定版本没有公开的外部 updateState 刷新方法；立即重新 hydrate 权威 checkpoint，
      // 避免 UI 保留已删除的未完成工具。TODO 15 替换消息投影时一并复核此最窄适配。
      stage = 'hydrate';
      await stream[STREAM_CONTROLLER].hydrate(activeThreadId);
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('stop generation failed:', { stage, error });
      setSubmissionError(
        stage === 'stop' ? '停止当前运行失败，请稍后重试'
          : stage === 'join' ? '已请求停止，但等待运行结束失败，请刷新后重试'
            : stage === 'hydrate' ? '未完成工具记录已清理，请刷新页面同步显示'
              : '已停止生成，但未完成工具记录清理失败，请刷新后重试'
      );
    } finally {
      if (currentClientRef.current === client) {
        await loadSessions();
        setStopReconciling(false);
        stopReconcilingRef.current = false;
      }
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
          isLiveServer={isLiveServer}
          hasMoreSessions={hasMoreSessions}
          isListLoading={isListLoading}
          listError={listError}
          onLoadMore={() => void loadSessions(true)}
          onRefreshSessions={() => void loadSessions()}
        />
      )}

      <ErrorBoundary fallbackTitle="会话窗口渲染异常">
        <ChatWindow
          messages={messages}
          contextSummary={contextSummary}
          contextUsage={isNewSessionDraft ? undefined : stream.values?.context_usage}
          onSendMessage={handleSendMessage}
          threadLoading={stream.isThreadLoading}
          runActive={stream.isLoading}
          stopReconciling={stopReconciling}
          hasRunningTool={hasRunningTool}
          renderOptimisticStatus={(messageId) => <OptimisticMessageStatus stream={stream} messageId={messageId} />}
          recommendations={recommendations}
          recommendationError={recommendationError}
          errorMessage={submissionError}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={() => setIsSidebarCollapsed(false)}
          isNewSessionDraft={isNewSessionDraft}
          onStopGeneration={() => void handleStopGeneration()}
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
          setStopReconciling(false);
          stopReconcilingRef.current = false;
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
          setIsLiveServer(false);
          setSubmissionError('');
          selectThread(null, 'replace');
          setApiUrl(nextUrl);
        }}
      />
    </div>
  );
};
