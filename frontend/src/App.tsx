import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStream } from '@langchain/react';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import {
  ThreadSession,
  Message,
  createSession,
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
  business_time?: string;
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
      setSessions(res.sessions || []);
      setActiveSession((current) => {
        if (isNewSessionDraft) return current;
        if (current) {
          const refreshed = res.sessions.find((item) => item.thread_id === current.thread_id);
          if (refreshed) return refreshed;
        }
        return res.sessions[0] || null;
      });
    } catch (error) {
      console.warn('loadSessions err:', error);
    }
  }, [isNewSessionDraft]);

  useEffect(() => {
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  const messages = useMemo<Message[]>(() => {
    const projected = projectLangGraphMessages((stream.messages || []) as unknown[]);
    if (!submissionError) return projected;
    return [
      ...projected,
      { id: 'stream-error', role: 'assistant', content: `⚠️ 会话请求失败：${submissionError}` },
    ];
  }, [stream.messages, submissionError]);

  const recommendations = useMemo(
    () =>
      Array.isArray(stream.values?.recommendations)
        ? stream.values.recommendations.filter((item): item is string => typeof item === 'string').slice(0, 3)
        : [],
    [stream.values?.recommendations]
  );
  const contextSummary =
    typeof stream.values?.context_summary === 'string' ? stream.values.context_summary : '';
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
    await renameSession(sessionId, newName);
    setSessions((current) =>
      current.map((session) =>
        session.thread_id === sessionId ? { ...session, name: newName } : session
      )
    );
    setActiveSession((current) =>
      current?.thread_id === sessionId ? { ...current, name: newName } : current
    );
  };

  const handleDeleteSession = async (sessionId: string) => {
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
  };

  const handleSendMessage = async (userText: string) => {
    const text = userText.trim();
    if (!text || stream.isLoading) return;
    setSubmissionError('');

    let targetSession = activeSession;
    if (isNewSessionDraft || !targetSession) {
      try {
        const created = await createSession('');
        targetSession = { ...created, name: '', isGeneratingTitle: true };
        setSessions((current) => [targetSession!, ...current]);
        setActiveSession(targetSession);
        setIsNewSessionDraft(false);

        void (async () => {
          let title = '新会话';
          try {
            title = (await generateSessionTitle(text)).trim() || title;
          } catch (error) {
            console.warn('generateSessionTitle error:', error);
          }
          await renameSession(created.thread_id, title);
          setSessions((current) =>
            current.map((session) =>
              session.thread_id === created.thread_id
                ? { ...session, name: title, isGeneratingTitle: false }
                : session
            )
          );
          setActiveSession((current) =>
            current?.thread_id === created.thread_id
              ? { ...current, name: title, isGeneratingTitle: false }
              : current
          );
        })();
      } catch (error) {
        setSubmissionError(error instanceof Error ? error.message : '无法创建会话');
        return;
      }
    }

    if (!targetSession) return;
    await stream.submit(
      { messages: [{ type: 'human', content: text }] },
      {
        threadId: targetSession.thread_id,
        multitaskStrategy: 'reject',
        onError: (error) =>
          setSubmissionError(error instanceof Error ? error.message : '连接智能体服务失败'),
      }
    );
    void loadSessions();
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

      <ChatWindow
        messages={messages}
        contextSummary={contextSummary}
        onSendMessage={handleSendMessage}
        isGenerating={stream.isLoading || stream.isThreadLoading}
        recommendations={recommendations}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed(false)}
        isNewSessionDraft={isNewSessionDraft}
        onStopGeneration={() => void stream.stop()}
      />

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
