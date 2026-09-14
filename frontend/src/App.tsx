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
  createSession,
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
  context_summary?: string;
  recommendations?: string[];
  recommendations_error?: string;
  business_time?: string;
  context_usage?: ContextUsage;
}

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [activeSession, setActiveSession] = useState<ThreadSession | null>(null);
  const [isNewSessionDraft, setIsNewSessionDraft] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isLiveServer, setIsLiveServer] = useState(false);
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  const [submissionError, setSubmissionError] = useState('');
  const [isStopping, setIsStopping] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const isSubmittingRef = useRef(false);
  const titleGenerationIdsRef = useRef(new Set<string>());

  const activeThreadId = isNewSessionDraft ? null : activeSession?.thread_id ?? null;
  const stream = useStream<LmaState>({
    assistantId: 'lma-agent',
    apiUrl,
    threadId: activeThreadId,
    messagesKey: 'messages',
  });

  const loadSessions = useCallback(async () => {
    try {
      const res = await getSessions();
      setIsLiveServer(res.isLive);
      setSessions((current) => {
        const currentById = new Map(current.map((session) => [session.thread_id, session]));
        return (res.sessions || []).map((session) => {
          const existing = currentById.get(session.thread_id);
          return titleGenerationIdsRef.current.has(session.thread_id) || existing?.isGeneratingTitle
            ? { ...session, name: '', isGeneratingTitle: true }
            : session;
        });
      });
      setActiveSession((current) => {
        if (isNewSessionDraft) return current;
        if (current) {
          const refreshed = res.sessions.find((item) => item.thread_id === current.thread_id);
          if (refreshed) {
            return titleGenerationIdsRef.current.has(refreshed.thread_id) || current.isGeneratingTitle
              ? { ...refreshed, name: '', isGeneratingTitle: true }
              : refreshed;
          }
        }
        return res.sessions[0] || null;
      });
    } catch (error) {
      console.warn('loadSessions err:', error);
      setIsLiveServer(false);
    }
  }, [isNewSessionDraft]);

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
  const contextSummary =
    typeof stream.values?.context_summary === 'string' ? stream.values.context_summary : '';
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
    setIsNewSessionDraft(false);
    setActiveSession(session);
  };

  const handleCreateSession = () => {
    stream.disconnect();
    setSubmissionError('');
    setIsNewSessionDraft(true);
    setActiveSession(null);
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      await renameSession(sessionId, newName);
      setSessions((current) =>
        current.map((session) =>
          session.thread_id === sessionId ? { ...session, name: newName } : session
        )
      );
      setActiveSession((current) =>
        current?.thread_id === sessionId ? { ...current, name: newName } : current
      );
    } catch (error) {
      setSubmissionError(error instanceof Error ? `重命名失败：${error.message}` : '重命名失败');
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
        setActiveSession(remaining[0] || null);
        setIsNewSessionDraft(remaining.length === 0);
      }
    } catch (error) {
      setSubmissionError(error instanceof Error ? `删除失败：${error.message}` : '删除失败');
    }
  };

  const handleSendMessage = async (userText: string) => {
    const text = userText.trim();
    if (!text || stream.isLoading || isStopping || isSubmittingRef.current) return;
    // 在第一个 await 前同步上锁，防止快速回车/双击同时创建两个 Thread。
    isSubmittingRef.current = true;
    setIsStartingRun(true);
    setSubmissionError('');

    let targetSession = activeSession;
    if (isNewSessionDraft || !targetSession) {
      const pendingThreadId = crypto.randomUUID();
      // 先登记客户端指定的 thread id，轮询即使抢先看到服务端 Thread，
      // 也只会展示标题骨架而不会闪现“监测会话-xxxxxx”。
      titleGenerationIdsRef.current.add(pendingThreadId);
      try {
        const created = await createSession('新会话', pendingThreadId);
        targetSession = { ...created, name: '', isGeneratingTitle: true };
        setSessions((current) => [targetSession!, ...current.filter((item) => item.thread_id !== created.thread_id)]);
        setActiveSession(targetSession);
        setIsNewSessionDraft(false);

        void (async () => {
          try {
            const generatedTitle = await generateSessionTitle(text);
            if (generatedTitle) {
              await renameSession(created.thread_id, generatedTitle);
              setSessions((current) =>
                current.map((session) =>
                  session.thread_id === created.thread_id
                    ? { ...session, name: generatedTitle, isGeneratingTitle: false }
                    : session
                )
              );
              setActiveSession((current) =>
                current?.thread_id === created.thread_id
                  ? { ...current, name: generatedTitle, isGeneratingTitle: false }
                  : current
              );
              return;
            }
          } catch (error) {
            console.warn('generateSessionTitle error:', error);
            setSubmissionError(error instanceof Error ? `会话标题生成失败：${error.message}` : '会话标题生成失败');
          } finally {
            titleGenerationIdsRef.current.delete(created.thread_id);
          }
          setSessions((current) =>
            current.map((session) =>
              session.thread_id === created.thread_id
                ? { ...session, name: '新会话', isGeneratingTitle: false }
                : session
            )
          );
          setActiveSession((current) =>
            current?.thread_id === created.thread_id
              ? { ...current, name: '新会话', isGeneratingTitle: false }
              : current
          );
        })();
      } catch (error) {
        titleGenerationIdsRef.current.delete(pendingThreadId);
        setSubmissionError(error instanceof Error ? error.message : '无法创建会话');
        isSubmittingRef.current = false;
        setIsStartingRun(false);
        return;
      }
    }

    if (!targetSession) {
      isSubmittingRef.current = false;
      setIsStartingRun(false);
      return;
    }
    try {
      await stream.submit(
        { messages: [{ type: 'human', content: text }] },
        {
          threadId: targetSession.thread_id,
          multitaskStrategy: 'reject',
          onError: (error) =>
            setSubmissionError(error instanceof Error ? error.message : '连接智能体服务失败'),
        }
      );
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
          activeSessionId={activeSession?.thread_id || null}
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
