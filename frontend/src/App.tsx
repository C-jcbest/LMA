import { runErrorMessage } from './services/api';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStream } from '@langchain/react';
import type { Client } from '@langchain/langgraph-sdk';
import { Sidebar, SidebarSession } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import { ContextUsage } from './components/ContextUsageIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  LMA_ASSISTANT_ID,
  createLangGraphClient,
  ThreadSession,
  Message,
  prepareThreadInput,
  generateSessionTitle,
  getSessions,
  getSessionStatuses,
  mergeThreadSessions,
  THREAD_PAGE_SIZE,
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

const readSelectedThreadId = () => new URL(window.location.href).searchParams.get('threadId') || null;

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  // URL 仅记录选择态；消息和运行状态始终由官方 SDK 恢复。
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    readSelectedThreadId
  );
  const selectedThreadRef = useRef(activeThreadId);
  selectedThreadRef.current = activeThreadId;
  const isNewSessionDraft = activeThreadId === null;
  const selectThread = useCallback((id: string | null, mode: 'push' | 'replace' = 'push') => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('threadId', id);
    else url.searchParams.delete('threadId');
    if (url.href !== window.location.href) {
      // 用户导航留下历史；SDK 分配 ID 和删除等原位更新不添加额外记录。
      if (mode === 'push') window.history.pushState(window.history.state, '', url);
      else window.history.replaceState(window.history.state, '', url);
    }
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
  const [isStopping, setIsStopping] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const isSubmittingRef = useRef(false);
  const isStoppingRef = useRef(false);

  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending' | 'creation_error' | 'save_error'>>({});
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isListLoading, setIsListLoading] = useState(false);
  const [sessionListError, setSessionListError] = useState('');
  const nextOffsetRef = useRef(0);
  const listLoadingRef = useRef(false);
  const titleJobsRef = useRef(new Map<string, { text: string; client: Client; creationNotified: boolean; titleStarted?: boolean }>());
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
    if (append && listLoadingRef.current) return;
    const request = ++sessionRequestRef.current;
    listLoadingRef.current = true;
    setIsListLoading(true);
    try {
      let offset = append ? nextOffsetRef.current : 0;
      const target = append ? offset + THREAD_PAGE_SIZE : Math.max(THREAD_PAGE_SIZE, nextOffsetRef.current);
      let collected: ThreadSession[] = [];
      let more = false;
      do {
        const res = await getSessions(client, offset);
        if (request !== sessionRequestRef.current) return;
        collected = mergeThreadSessions(collected, res.sessions);
        offset = res.nextOffset;
        more = res.hasMore;
      } while (more && offset < target);
      if (request !== sessionRequestRef.current) return;
      nextOffsetRef.current = offset;
      setHasMoreSessions(more);
      setIsLiveServer(true);
      setSessionListError('');
      setSessions((current) => append ? mergeThreadSessions(current, collected) : collected);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
      setIsLiveServer(false);
      setSessionListError('会话列表加载失败，已保留当前列表。请刷新重试。');
    } finally {
      if (request === sessionRequestRef.current) {
        listLoadingRef.current = false;
        setIsListLoading(false);
      }
    }
  }, [client]);

  const onThreadId = useCallback((id: string) => {
    if (currentClientRef.current !== client) return;
    selectThread(id, 'replace');
    const input = firstInputRef.current;
    if (input) {
      titleJobsRef.current.set(id, { ...input, creationNotified: false });
      setTitleViews((current) => ({ ...current, [id]: 'pending' }));
    }
  }, [selectThread, client]);

  const onCreated = useCallback(({ runId }: { runId: string }) => {
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
          setSessions((items) => mergeThreadSessions(items, confirmed));
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
  }, [clearTitleView, loadSessions]);

  const stream = useStream<LmaState>({
    assistantId: LMA_ASSISTANT_ID,
    client,
    threadId: activeThreadId,
    messagesKey: 'messages',
    optimistic: true,
    onThreadId,
    onCreated,
  });

  useEffect(() => {
    const onPopState = () => {
      const id = readSelectedThreadId();
      if (id === selectedThreadRef.current) return;
      // 仅断开客户端订阅；服务器 Run 与 checkpoint 仍由官方 SDK 管理。
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
    return items;
  }, [sessions, titleViews]);

  useEffect(() => {
    void loadSessions();
    return () => {
      ++sessionRequestRef.current;
    };
  }, [loadSessions]);

  const messages = useMemo<Message[]>(() => {
    if (isNewSessionDraft) return [];
    const projected = projectLangGraphMessages((stream.messages || []) as unknown[], {
      isRunActive: stream.isLoading,
    });
    return projected;
  }, [stream.messages, stream.isLoading, isNewSessionDraft]);

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
  const generatingThreadIds = useMemo(() => {
    const busy = sessions
      .filter((session) => session.status === 'busy')
      .map((session) => session.thread_id);
    if (stream.isLoading && activeThreadId && !busy.includes(activeThreadId)) busy.push(activeThreadId);
    return busy;
  }, [sessions, stream.isLoading, activeThreadId]);

  const busyIdsKey = [...new Set([
    ...sessions.filter((session) => session.status === 'busy').map((session) => session.thread_id),
    ...(stream.isLoading && activeThreadId ? [activeThreadId] : []),
  ])].sort().join(',');
  useEffect(() => {
    if (!busyIdsKey) return;
    let disposed = false;
    let refreshing = false;
    const refreshBusy = async () => {
      if (refreshing || listLoadingRef.current || deletingThreadsRef.current.size) return;
      refreshing = true;
      const request = sessionRequestRef.current;
      try {
        const refreshed = await getSessionStatuses(client, busyIdsKey.split(','));
        if (disposed || request !== sessionRequestRef.current) return;
        setSessions((items) => mergeThreadSessions(items, refreshed));
        setIsLiveServer(true);
        setSessionListError('');
      } catch (error) {
        if (disposed || request !== sessionRequestRef.current) return;
        console.warn('refresh busy sessions error:', error);
        setIsLiveServer(false);
        setSessionListError('运行状态刷新失败，已保留上次确认状态。请刷新重试。');
      } finally { refreshing = false; }
    };
    // 仅有已知 busy Thread 时，每3秒查询这些 ID 的列表字段，不刷新所有分页。
    const timer = window.setInterval(() => void refreshBusy(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [busyIdsKey, client]);

  const handleSelectSession = (session: Pick<ThreadSession, 'thread_id'>) => {
    if (session.thread_id === selectedThreadRef.current) return;
    stream.disconnect();
    setSubmissionError('');
    selectThread(session.thread_id);
  };

  const handleCreateSession = () => {
    if (selectedThreadRef.current === null) return;
    stream.disconnect();
    setSubmissionError('');
    selectThread(null);
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      const renamed = await renameSession(client, sessionId, newName);
      if (currentClientRef.current !== client) return;
      setSessions((current) => mergeThreadSessions(current, projectThreadSessions([renamed])));
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
    if (!text || stream.isLoading || isStopping || isSubmittingRef.current) return;
    // 在第一个 await 前同步上锁，防止快速回车/双击同时创建两个 Thread。
    isSubmittingRef.current = true;
    setIsStartingRun(true);
    setSubmissionError('');

    const isFirstMessage = activeThreadId === null;
    if (isFirstMessage) firstInputRef.current = { text, client: stream.client };
    try {
      const inputMessages = activeThreadId ? await prepareThreadInput(client, activeThreadId, text)
        : [{ type: 'human' as const, content: text }];
      if (currentClientRef.current !== client || selectedThreadRef.current !== activeThreadId) return;
      // 乐观消息由官方 SDK 注入并与 checkpoint 协调，不在应用中复制消息。
      await stream.submit(
        { messages: inputMessages },
        {
          multitaskStrategy: 'reject',
          onError: (error) => {
            if (currentClientRef.current !== client) return;
            setSubmissionError(runErrorMessage(error));
            for (const [id, job] of titleJobsRef.current) {
              if (!job.creationNotified) {
                setTitleViews((current) => ({ ...current, [id]: 'creation_error' }));
              }
            }
          },
        }
      );
    } catch (error) {
      if (currentClientRef.current !== client) return;
      setSubmissionError(runErrorMessage(error));
    } finally {
      if (currentClientRef.current === client) {
        firstInputRef.current = null;
        isSubmittingRef.current = false;
        setIsStartingRun(false);
        void loadSessions();
      }
    }
  };

  const handleStopGeneration = async () => {
    if (!activeThreadId || !stream.isLoading || isStoppingRef.current) return;
    isStoppingRef.current = true;
    setSubmissionError('');
    setIsStopping(true);
    try {
      await stream.stop();
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('stop generation error:', error);
      setSubmissionError('停止请求未完成，请检查会话运行状态后重试。');
    } finally {
      if (currentClientRef.current === client) {
        await loadSessions();
        setIsStopping(false);
        isStoppingRef.current = false;
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
          generatingThreadIds={generatingThreadIds}
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
          sessionListError={sessionListError}
          onLoadMore={() => void loadSessions(true)}
          onRefresh={() => void loadSessions()}
        />
      )}

      <ErrorBoundary fallbackTitle="会话窗口渲染异常">
        <ChatWindow
          messages={messages}
          contextSummary={contextSummary}
          contextUsage={isNewSessionDraft ? undefined : stream.values?.context_usage}
          onSendMessage={handleSendMessage}
          isGenerating={stream.isLoading || stream.isThreadLoading || isStopping || isStartingRun}
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
          setIsStartingRun(false);
          setIsStopping(false);
          isStoppingRef.current = false;
          setTitleViews({});
          nextOffsetRef.current = 0;
          listLoadingRef.current = false;
          setHasMoreSessions(false);
          setIsListLoading(false);
          setSessionListError('');
          deletingThreadsRef.current.clear();
          setDeletingThreadIds([]);
          setSessions([]);
          setIsLiveServer(false);
          setSubmissionError('');
          selectThread(null, 'replace');
          setApiUrl(nextUrl);
        }}
      />
    </div>
  );
};
