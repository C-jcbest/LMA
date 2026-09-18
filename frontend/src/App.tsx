import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStream, useToolCalls } from '@langchain/react';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import { ContextUsage } from './components/ContextUsageIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OptimisticMessageStatus } from './components/OptimisticMessageStatus';
import { ToastContainer, useToast } from './components/Toast';
import {
  LMA_ASSISTANT_ID,
  createLangGraphClient,
  ThreadSession,
  getStoredApiUrl,
} from './services/api';
import { useThreadNavigation } from './hooks/useThreadNavigation';
import { useThreadDirectory } from './hooks/useThreadDirectory';
import { useAuxiliaryRuns } from './hooks/useAuxiliaryRuns';
import { useThreadActions } from './hooks/useThreadActions';

interface LmaState {
  messages: BaseMessage[];
  recommendations?: string[];
  context_usage?: ContextUsage;
}

export const App: React.FC = () => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);

  // 官方 Hook 和所有辅助请求共用实例；业务请求不再重新读取 localStorage。
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);
  const currentClientRef = useRef(client);
  currentClientRef.current = client;

  const deletingThreadsRef = useRef(new Set<string>());
  const isSubmittingRef = useRef(false);

  const { toasts, showToast, dismissToast } = useToast();
  const [runError, setRunError] = useState(false);
  const [hydrationError, setHydrationError] = useState(false);

  // 1. 会话路由与 URL 选择态
  const {
    activeThreadId,
    selectedThreadRef,
    isNewSessionDraft,
    selectThread,
  } = useThreadNavigation({
    onNavigate: () => {
      stream.disconnect();
    },
  });

  // 2. 会话列表与状态轮询
  const {
    sessions,
    setSessions,
    hasMoreSessions,
    setHasMoreSessions,
    isListLoading,
    setIsListLoading,
    listError,
    setListError,
    loadSessions,
    nextOffsetRef,
    listPendingRef,
    sessionRequestRef,
  } = useThreadDirectory({
    client,
    currentClientRef,
    deletingThreadsRef,
  });

  // 3. 辅助 Run：标题生成与侧边栏投影
  const {
    titleViews,
    setTitleViews,
    newThreadOrder,
    setNewThreadOrder,
    titleJobsRef,
    activeSubmissionRef,
    firstInputRef,
    clearTitleView,
    onThreadId,
    onCreated,
    sidebarSessions,
  } = useAuxiliaryRuns({
    client,
    currentClientRef,
    sessionRequestRef,
    sessions,
    setSessions,
    loadSessions,
    selectThread,
  });

  // 4. 官方主流式 Hook
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

  // 5. 会话重命名与安全删除
  const {
    deletingThreadIds,
    handleRenameSession,
    handleDeleteSession,
  } = useThreadActions({
    client,
    currentClientRef,
    selectedThreadRef,
    sessionRequestRef,
    deletingThreadsRef,
    titleJobsRef,
    setSessions,
    setNewThreadOrder,
    clearTitleView,
    loadSessions,
    selectThread,
    showToast,
  });

  // 监听 Thread hydration 状态
  useEffect(() => {
    if (!activeThreadId) return;
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
  }, [activeThreadId, stream.hydrationPromise, selectedThreadRef]);

  const handleReloadThread = async () => {
    if (!activeThreadId) return;
    const targetThreadId = activeThreadId;
    setHydrationError(false);
    try {
      if (selectedThreadRef.current === targetThreadId) {
        await stream.disconnect();
        selectThread(null, 'replace');
        setTimeout(() => {
          if (selectedThreadRef.current === null) {
            selectThread(targetThreadId, 'replace');
          }
        }, 0);
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
  }, [activeThreadId]);

  // TODO 14: 唯一流式数据源收敛：消息严格只从 stream.messages 读取
  const messages = isNewSessionDraft ? [] : stream.messages;

  const recommendations = useMemo(
    () =>
      Array.isArray(stream.values?.recommendations)
        ? stream.values.recommendations.filter((item): item is string => typeof item === 'string').slice(0, 3)
        : [],
    [stream.values?.recommendations]
  );

  const contextSummary = useMemo(() => {
    if (isNewSessionDraft) return '';
    const summary = (stream.messages || []).find(
      (message) =>
        HumanMessage.isInstance(message) &&
        message.additional_kwargs?.lc_source === 'summarization'
    );
    return typeof summary?.content === 'string' ? summary.content : '';
  }, [stream.messages, isNewSessionDraft]);

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

  const handleSendMessage = async (userText: string) => {
    const text = userText.trim();
    if (!text || stream.isThreadLoading || stream.isLoading || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setRunError(false);

    const isFirstMessage = activeThreadId === null;
    const submission = { client, threadId: activeThreadId };
    activeSubmissionRef.current = submission;
    if (isFirstMessage) firstInputRef.current = { text, client: stream.client };
    try {
      await stream.submit(
        { messages: [new HumanMessage({ content: text })] },
        {
          multitaskStrategy: 'reject',
          onError: () => {
            if (currentClientRef.current === submission.client && selectedThreadRef.current === submission.threadId) {
              setRunError(true);
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
      if (currentClientRef.current === submission.client && selectedThreadRef.current === submission.threadId) {
        setRunError(true);
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

  const handleRegenerate = async (checkpointId: string, lastHumanMsg?: BaseMessage) => {
    if (stream.isLoading || isSubmittingRef.current) return;
    const currentThreadId = activeThreadId;
    if (!currentThreadId || !checkpointId) return;

    const lastHuman =
      ([...(stream.messages || [])]
        .reverse()
        .find((message) => HumanMessage.isInstance(message)) as BaseMessage | undefined) ||
      lastHumanMsg;
    if (!lastHuman) return;

    isSubmittingRef.current = true;
    setRunError(false);
    const submission = { client, threadId: currentThreadId };
    activeSubmissionRef.current = submission;

    try {
      await stream.submit(
        { messages: [lastHuman] },
        {
          forkFrom: checkpointId,
          multitaskStrategy: 'reject',
          onError: () => {
            if (currentClientRef.current === submission.client && selectedThreadRef.current === currentThreadId) {
              setRunError(true);
            }
          },
        }
      );
    } catch (error) {
      if (currentClientRef.current === submission.client && selectedThreadRef.current === currentThreadId) {
        setRunError(true);
      }
    } finally {
      if (currentClientRef.current === client) {
        if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
        isSubmittingRef.current = false;
        void loadSessions();
      }
    }
  };

  const handleRetryMessage = async (messageId: string) => {
    if (stream.isThreadLoading || stream.isLoading || isSubmittingRef.current) return;
    const message = (stream.messages || []).find((m: any) => m.id === messageId);
    if (!message) return;

    isSubmittingRef.current = true;
    setRunError(false);

    const isFirstMessage = activeThreadId === null;
    const submission = { client, threadId: activeThreadId };
    activeSubmissionRef.current = submission;
    const text = typeof message.content === 'string' ? message.content : '';
    if (isFirstMessage && text) firstInputRef.current = { text, client: stream.client };

    try {
      await stream.submit(
        { messages: [message] },
        {
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          multitaskStrategy: 'reject',
          onError: () => {
            if (currentClientRef.current === submission.client && selectedThreadRef.current === submission.threadId) {
              setRunError(true);
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
      if (currentClientRef.current === submission.client && selectedThreadRef.current === submission.threadId) {
        setRunError(true);
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

  const handleStopGeneration = async () => {
    try {
      await stream.stop({ cancel: true });
    } catch (error) {
      console.warn('stop generation failed:', error);
    } finally {
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
          onDeleteSession={(id) => void handleDeleteSession(id, stream)}
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
          toolCalls={toolCalls}
          contextSummary={contextSummary}
          contextUsage={isNewSessionDraft ? undefined : stream.values?.context_usage}
          onSendMessage={handleSendMessage}
          threadLoading={stream.isThreadLoading}
          runActive={stream.isLoading}
          renderOptimisticStatus={(messageId) => (
            <OptimisticMessageStatus
              stream={stream}
              messageId={messageId}
              onRetry={() => messageId && void handleRetryMessage(messageId)}
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
          setTitleViews({});
          setNewThreadOrder([]);
          deletingThreadsRef.current.clear();
          setSessions([]);
          nextOffsetRef.current = 0;
          listPendingRef.current = false;
          setHasMoreSessions(false);
          setIsListLoading(false);
          setListError('');
          setRunError(false);
          setHydrationError(false);
          selectThread(null, 'replace');
          setApiUrl(nextUrl);
        }}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
