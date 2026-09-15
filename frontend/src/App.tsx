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
  closeInterruptedToolCalls,
  generateSessionTitle,
  getSessions,
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
  // URL 仅记录选择态；消息和运行状态始终由官方 SDK 恢复。
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => new URL(window.location.href).searchParams.get('threadId')
  );
  const selectedThreadRef = useRef(activeThreadId);
  selectedThreadRef.current = activeThreadId;
  const isNewSessionDraft = activeThreadId === null;
  const selectThread = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('threadId', id);
    else url.searchParams.delete('threadId');
    window.history.replaceState(null, '', url);
    setActiveThreadId(id);
  }, []);
  useEffect(() => {
    const onPopState = () => setActiveThreadId(new URL(window.location.href).searchParams.get('threadId'));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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

  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending' | 'creation_error' | 'save_error'>>({});
  const [newThreadOrder, setNewThreadOrder] = useState<string[]>([]);
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
  const loadSessions = useCallback(async () => {
    if (currentClientRef.current !== client || deletingThreadsRef.current.size) return;
    const request = ++sessionRequestRef.current;
    try {
      const res = await getSessions(client);
      if (request !== sessionRequestRef.current) return;
      setIsLiveServer(res.isLive);
      setSessions(res.sessions);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
      setIsLiveServer(false);
    }
  }, [client]);

  const onThreadId = useCallback((id: string) => {
    if (currentClientRef.current !== client) return;
    selectThread(id);
    const input = firstInputRef.current;
    if (input) {
      setNewThreadOrder((ids) => [id, ...ids.filter((item) => item !== id)]);
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
          setSessions((items) => [
            ...items.filter((item) => item.thread_id !== id), ...confirmed,
          ]);
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
    const order = new Map(newThreadOrder.map((id, index) => [id, index]));
    return items.sort((a, b) => (order.get(a.thread_id) ?? newThreadOrder.length) - (order.get(b.thread_id) ?? newThreadOrder.length));
  }, [sessions, titleViews, newThreadOrder]);

  useEffect(() => {
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3000);
    return () => {
      window.clearInterval(timer);
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
      if (selectedThreadRef.current === sessionId) selectThread(null);
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
      // 乐观消息由官方 SDK 注入并与 checkpoint 协调，不在应用中复制消息。
      await stream.submit(
        { messages: [{ type: 'human', content: text }] },
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
    if (!activeThreadId) return;
    const rawMessages = [...(stream.messages || [])] as unknown[];
    setSubmissionError('');
    setIsStopping(true);
    try {
      await stream.stop();
      if (currentClientRef.current !== client) return;
      await closeInterruptedToolCalls(client, activeThreadId, rawMessages);
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('stop generation cleanup error:', error);
      setSubmissionError('已停止生成，但会话状态清理失败，请刷新后重试');
    } finally {
      if (currentClientRef.current === client) {
        await loadSessions();
        setIsStopping(false);
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
          setTitleViews({});
          setNewThreadOrder([]);
          deletingThreadsRef.current.clear();
          setDeletingThreadIds([]);
          setSessions([]);
          setIsLiveServer(false);
          setSubmissionError('');
          selectThread(null);
          setApiUrl(nextUrl);
        }}
      />
    </div>
  );
};
