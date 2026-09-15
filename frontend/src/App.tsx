import { runErrorMessage } from './services/api';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStream } from '@langchain/react';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import { ContextUsage } from './components/ContextUsageIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  ThreadSession,
  Message,
  closeInterruptedToolCalls,
  deleteSession,
  generateSessionTitle,
  getSessions,
  getStoredApiUrl,
  projectLangGraphMessages,
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
  const [submissionError, setSubmissionError] = useState('');
  const [isStopping, setIsStopping] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const isSubmittingRef = useRef(false);

  const stream = useStream<LmaState>({
    assistantId: 'lma-agent',
    apiUrl,
    threadId: activeThreadId,
    messagesKey: 'messages',
    onThreadId: selectThread,
  });

  const loadSessions = useCallback(async () => {
    try {
      const res = await getSessions();
      setIsLiveServer(res.isLive);
      setSessions(res.sessions);
    } catch (error) {
      console.warn('loadSessions err:', error);
      setIsLiveServer(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  const messages = useMemo<Message[]>(() => {
    const projected = projectLangGraphMessages((stream.messages || []) as unknown[], {
      isRunActive: stream.isLoading,
    });
    return projected;
  }, [stream.messages, stream.isLoading]);

  const recommendations = useMemo(
    () =>
      Array.isArray(stream.values?.recommendations)
        ? stream.values.recommendations.filter((item): item is string => typeof item === 'string').slice(0, 3)
        : [],
    [stream.values?.recommendations]
  );
  const contextSummary = useMemo(() => {
    const summary = (stream.values?.messages || []).find((message: any) =>
      message?.additional_kwargs?.lc_source === 'summarization'
    ) as { content?: unknown } | undefined;
    return typeof summary?.content === 'string' ? summary.content : '';
  }, [stream.values?.messages]);
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

  const handleSelectSession = (session: ThreadSession) => {
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
      await renameSession(sessionId, newName);
      setSessions((current) =>
        current.map((session) =>
          session.thread_id === sessionId ? { ...session, name: newName } : session
        )
      );
    } catch (error) {
      console.warn('rename session error:', error);
      setSubmissionError('重命名失败，请稍后重试');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      if (sessionId === activeThreadId && stream.isLoading) await stream.stop();
      await deleteSession(sessionId);
      const remaining = sessions.filter((session) => session.thread_id !== sessionId);
      setSessions(remaining);
      if (sessionId === activeThreadId) {
        stream.disconnect();
        setSubmissionError('');
        selectThread(remaining[0]?.thread_id ?? null);
      }
    } catch (error) {
      console.warn('delete session error:', error);
      setSubmissionError('删除失败，请稍后重试');
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
    let failed = false;
    try {
      // 不预创建 Thread、不分配 ID、不覆盖 SDK 当前 Thread。
      const submission = stream.submit(
        { messages: [{ type: 'human', content: text }] },
        {
          multitaskStrategy: 'reject',
          onError: (error) => {
            failed = true;
            setSubmissionError(runErrorMessage(error));
          },
        }
      );
      // 在 await 前读取 SDK 绑定的 ID，切换会话不改变本次元数据更新目标。
      const submittedThreadId = stream.getThread()?.threadId;
      await submission;
      if (isFirstMessage && submittedThreadId) {
        // 创建与 Run 的提交由 SDK 的 run.start 管理；拿到 ID 不等于已落库。
        // 只登记服务端确认接受了 Run 或 checkpoint 的会话，失败诊断不进聊天。
        void (async () => {
          try {
            const runs = await stream.client.runs.list(submittedThreadId, { limit: 1 });
            const state = await stream.client.threads.getState(submittedThreadId);
            const history = await stream.client.threads.getHistory(submittedThreadId, { limit: 1 });
            if (!runs.length && !history.length && !state.checkpoint?.checkpoint_id) return;
            const thread = await stream.client.threads.get(submittedThreadId);
            if (thread.metadata?.name) return;
            await stream.client.threads.update(submittedThreadId, { metadata: { name: '新会话' } });
            await loadSessions();
            if (failed) return;
            const title = await generateSessionTitle(text);
            // 不覆盖用户在标题生成期间确认的手动重命名。
            const current = await stream.client.threads.get(submittedThreadId);
            if (current.metadata?.name !== '新会话') return;
            await stream.client.threads.update(submittedThreadId, { metadata: { name: title } });
            await loadSessions();
          } catch (error) {
            console.warn('session metadata update error:', error);
          }
        })();
      }
    } catch (error) {
      setSubmissionError(runErrorMessage(error));
    } finally {
      isSubmittingRef.current = false;
      setIsStartingRun(false);
      void loadSessions();
    }
  };

  const handleStopGeneration = async () => {
    if (!activeThreadId) return;
    const rawMessages = [...(stream.messages || [])] as unknown[];
    setSubmissionError('');
    setIsStopping(true);
    try {
      await stream.stop();
      await closeInterruptedToolCalls(activeThreadId, rawMessages);
    } catch (error) {
      console.warn('stop generation cleanup error:', error);
      setSubmissionError('已停止生成，但会话状态清理失败，请刷新后重试');
    } finally {
      await loadSessions();
      setIsStopping(false);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      {!isSidebarCollapsed && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeThreadId}
          isNewSessionDraft={isNewSessionDraft}
          generatingThreadIds={generatingThreadIds}
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
          contextUsage={stream.values?.context_usage}
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
          stream.disconnect();
          setApiUrl(getStoredApiUrl());
          void loadSessions();
        }}
      />
    </div>
  );
};
