import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStream, useToolCalls } from '@langchain/react';
import type { Client } from '@langchain/langgraph-sdk';
import type { BaseMessage } from '@langchain/core/messages';
import { Sidebar, SidebarSession } from './components/Sidebar';
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
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  // 官方 Hook 和所有辅助请求共用实例；业务请求不再重新读取 localStorage。
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);
  const currentClientRef = useRef(client);
  currentClientRef.current = client;

  // 官方 stream.isLoading 已覆盖 Run 启动与执行；本地仅保留 Stop 后的 checkpoint 清理过渡态。
  const [stopReconciling, setStopReconciling] = useState(false);
  const stopReconcilingRef = useRef(false);
  const isSubmittingRef = useRef(false);

  // 分层错误交互模型：当前会话的瞬时错误，切换会话时自动重置
  const { toasts, showToast, dismissToast } = useToast();
  const [runError, setRunError] = useState(false);
  const [hydrationError, setHydrationError] = useState(false);
  const [stopError, setStopError] = useState(false);

  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending'>>({});
  const [newThreadOrder, setNewThreadOrder] = useState<string[]>([]);
  const titleJobsRef = useRef(new Map<string, { text: string; client: Client; creationNotified: boolean; titleStarted?: boolean }>());
  const activeSubmissionRef = useRef<{
    client: Client;
    threadId: string | null;
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
      setSessions((current) => mergeSessions(append ? current : [], rows));
      nextOffsetRef.current = res.nextOffset;
      setHasMoreSessions(res.hasMore);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
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
  const toolCalls = useToolCalls(stream);
  const hasRunningTool = toolCalls.some((toolCall) => toolCall.status === 'running');

  // 监听 Thread hydration 状态
  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const targetThreadId = activeThreadId;
    let active = true;
    stream.hydrationPromise?.then(
      () => {
        if (active && selectedThreadRef.current === targetThreadId) {
          setHydrationError(false);
        }
      },
      (error) => {
        if (active && selectedThreadRef.current === targetThreadId) {
          console.warn('thread hydration error:', error);
          setHydrationError(true);
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
    setHydrationError(false);
    try {
      if (selectedThreadRef.current === targetThreadId) {
        await rehydrateThread(stream, targetThreadId);
      }
    } catch (error) {
      console.warn('reload thread failed:', error);
      if (selectedThreadRef.current === targetThreadId) {
        setHydrationError(true);
      }
    }
  };

  useEffect(() => {
    setRunError(false);
    setHydrationError(false);
    setStopError(false);
  }, [activeThreadId]);

  useEffect(() => {
    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId');
      if (selectedThreadRef.current === id) return;
      // 导航只断开订阅，服务端 Run 继续；历史由 SDK 根据 URL ID 恢复。
      stream.disconnect();
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
  const busyThreadIds = useMemo(() => {
    const busy = sessions
      .filter((session) => session.thread_id !== activeThreadId && session.status === 'busy')
      .map((session) => session.thread_id);
    if (stream.isLoading && activeThreadId && !busy.includes(activeThreadId)) busy.push(activeThreadId);
    return busy;
  }, [sessions, stream.isLoading, activeThreadId]);

  const handleSelectSession = (session: Pick<ThreadSession, 'thread_id'>) => {
    stream.disconnect();
    selectThread(session.thread_id);
  };

  const handleCreateSession = () => {
    stream.disconnect();
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
    setRunError(false);
    setStopError(false);

    const isFirstMessage = activeThreadId === null;
    const submission = { client, threadId: activeThreadId, stopped: false };
    activeSubmissionRef.current = submission;
    if (isFirstMessage) firstInputRef.current = { text, client: stream.client };
    try {
      // 乐观消息由官方 SDK 注入并与 checkpoint 协调，不在应用中复制消息。
      await stream.submit(
        { messages: [{ type: 'human', content: text }] },
        {
          multitaskStrategy: 'reject',
          onError: () => {
            if (!submission.stopped && currentClientRef.current === submission.client) {
              if (selectedThreadRef.current === submission.threadId) {
                setRunError(true);
              }
            }
            for (const [id, job] of titleJobsRef.current) {
              if (!job.creationNotified) {
                clearTitleView(id);
                titleJobsRef.current.delete(id);
              }
            }
          },
        }
      );
    } catch (error) {
      if (!submission.stopped && currentClientRef.current === submission.client) {
        if (selectedThreadRef.current === submission.threadId) {
          setRunError(true);
        }
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
  const handleRegenerate = async (checkpointId: string, lastHumanMsg?: BaseMessage) => {
    if (stream.isLoading || isSubmittingRef.current || stopReconciling) return;
    const currentThreadId = activeThreadId;
    if (!currentThreadId || !checkpointId) return;

    // 从 stream.messages 中寻找该轮次最后一条 HumanMessage（保留其完整属性）
    const lastHuman =
      ([...(stream.messages || [])]
        .reverse()
        .find((m: any) => m.type === 'human' || m._getType?.() === 'human') as BaseMessage | undefined) ||
      lastHumanMsg;
    if (!lastHuman) return;

    isSubmittingRef.current = true;
    setRunError(false);
    const submission = { client, threadId: currentThreadId, stopped: false };
    activeSubmissionRef.current = submission;

    try {
      await stream.submit(
        { messages: [lastHuman] },
        {
          forkFrom: checkpointId,
          multitaskStrategy: 'reject',
          onError: () => {
            if (!submission.stopped && currentClientRef.current === submission.client) {
              if (selectedThreadRef.current === currentThreadId) {
                setRunError(true);
              }
            }
          },
        }
      );
    } catch (error) {
      if (!submission.stopped && currentClientRef.current === submission.client) {
        if (selectedThreadRef.current === currentThreadId) {
          setRunError(true);
        }
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
    if (!targetThreadId || stopReconcilingRef.current) return;

    stopReconcilingRef.current = true;
    setStopReconciling(true);
    setStopError(false);
    if (activeSubmissionRef.current?.threadId === targetThreadId) {
      activeSubmissionRef.current.stopped = true;
    }

    try {
      await stream.stop({ cancel: true });
      await removeIncompleteToolCallMessages(client, targetThreadId);
      if (selectedThreadRef.current === targetThreadId) {
        await rehydrateThread(stream, targetThreadId);
      }
    } catch (error) {
      console.warn('stop generation failed:', error);
      if (selectedThreadRef.current === targetThreadId) {
        setStopError(true);
      }
    } finally {
      stopReconcilingRef.current = false;
      setStopReconciling(false);
      if (currentClientRef.current === client) {
        await loadSessions();
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
          hasMoreSessions={hasMoreSessions}
          isListLoading={isListLoading}
          listError={listError}
          onLoadMore={() => void loadSessions(true)}
          onRefreshSessions={() => void loadSessions()}
          onDismissListError={() => setListError('')}
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
          runError={runError}
          onRegenerate={(checkpointId, message) => void handleRegenerate(checkpointId, message)}
          onDismissRunError={() => setRunError(false)}
          hydrationError={hydrationError}
          onReloadThread={() => void handleReloadThread()}
          onDismissHydrationError={() => setHydrationError(false)}
          stopError={stopError}
          onRetryStop={() => void handleStopGeneration()}
          onDismissStopError={() => setStopError(false)}
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
          stopReconcilingRef.current = false;
          setStopReconciling(false);
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
          setRunError(false);
          setStopError(false);
          setHydrationError(false);
          selectThread(null, 'replace');
          setApiUrl(nextUrl);
        }}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
