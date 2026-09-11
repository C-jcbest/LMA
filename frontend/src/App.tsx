import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import {
  ThreadSession,
  Message,
  MessagePart,
  getSessions,
  createSession,
  renameSession,
  deleteSession,
  getSessionMessages,
  streamChatWithLangGraph,
  generateSessionTitle,
} from './services/api';

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [activeSession, setActiveSession] = useState<ThreadSession | null>(null);
  const [isNewSessionDraft, setIsNewSessionDraft] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextSummary, setContextSummary] = useState<string>('');
  const [recommendations, setRecommendations] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingParts, setStreamingParts] = useState<MessagePart[]>([]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isLiveServer, setIsLiveServer] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化加载会话
  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const res = await getSessions();
      setIsLiveServer(res.isLive);
      if (res.sessions && res.sessions.length > 0) {
        setSessions(res.sessions);
        if (!activeSession || !res.sessions.some((s) => s.thread_id === activeSession.thread_id)) {
          const first = res.sessions[0];
          setActiveSession(first);
          loadMessages(first.thread_id);
        }
      } else {
        setSessions([]);
        setActiveSession(null);
        setMessages([]);
      }
    } catch (e) {
      console.warn('loadSessions err:', e);
    }
  };

  const loadMessages = async (threadId: string) => {
    try {
      const res = await getSessionMessages(threadId);
      setMessages(res.messages);
      setContextSummary(res.contextSummary || '');
      setRecommendations(res.recommendations || []);
    } catch (e) {
      console.warn('loadMessages err:', e);
    }
  };

  const handleSelectSession = (session: ThreadSession) => {
    setIsNewSessionDraft(false);
    setActiveSession(session);
    setStreamingText('');
    setStreamingParts([]);
    setRecommendations([]);
    loadMessages(session.thread_id);
  };

  const handleCreateSession = () => {
    abortControllerRef.current?.abort();
    setIsNewSessionDraft(true);
    setActiveSession(null);
    setMessages([]);
    setStreamingText('');
    setStreamingParts([]);
    setRecommendations([]);
    setLoading(false);
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    await renameSession(sessionId, newName);
    setSessions((prev) =>
      prev.map((s) => (s.thread_id === sessionId ? { ...s, name: newName } : s))
    );
    if (activeSession?.thread_id === sessionId) {
      setActiveSession((prev) => (prev ? { ...prev, name: newName } : null));
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    await deleteSession(sessionId);
    const updated = sessions.filter((s) => s.thread_id !== sessionId);
    setSessions(updated);
    if (activeSession?.thread_id === sessionId) {
      const next = updated[0] || null;
      if (next) {
        setActiveSession(next);
        setIsNewSessionDraft(false);
        loadMessages(next.thread_id);
      } else {
        handleCreateSession();
      }
    }
  };

  const handleSendMessage = async (userText: string) => {
    if (!userText.trim() || loading) return;

    let targetSession = activeSession;
    const isDraft = isNewSessionDraft || !targetSession;

    if (isDraft) {
      try {
        // 1. 正式创建会话，标记为正在生成标题，名称暂留空
        const newSession = await createSession('');
        newSession.isGeneratingTitle = true;
        newSession.name = '';

        targetSession = newSession;
        setSessions((prev) => [newSession, ...prev]);
        setActiveSession(newSession);
        setIsNewSessionDraft(false);

        // 2. 并行触发异步标题生成任务
        (async () => {
          let finalTitle = '新会话';
          try {
            const title = await generateSessionTitle(userText);
            if (title && title.trim()) {
              finalTitle = title.trim();
            }
          } catch (e) {
            console.warn('generateSessionTitle error, fallback to default title:', e);
          }
          await renameSession(newSession.thread_id, finalTitle);
          setSessions((prev) =>
            prev.map((s) =>
              s.thread_id === newSession.thread_id
                ? { ...s, name: finalTitle, isGeneratingTitle: false }
                : s
            )
          );
          setActiveSession((curr) =>
            curr?.thread_id === newSession.thread_id
              ? { ...curr, name: finalTitle, isGeneratingTitle: false }
              : curr
          );
        })();
      } catch (err) {
        console.error('Failed to initialize session:', err);
        return;
      }
    }

    if (!targetSession) return;

    const newUserMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userText,
    };

    setMessages((prev) => [...prev, newUserMsg]);
    setLoading(true);
    setStreamingText('');
    setStreamingParts([]);
    setRecommendations([]);

    abortControllerRef.current = new AbortController();

    try {
      let finalCapturedParts: MessagePart[] = [];

      const finalReply = await streamChatWithLangGraph(
        targetSession.thread_id,
        userText,
        {
          onToken: (chunk) => {
            setStreamingText((prev) => prev + chunk);
          },
          onPartsUpdate: (parts) => {
            finalCapturedParts = parts;
            setStreamingParts([...parts]);
          },
          onRecommendations: (list) => {
            setRecommendations(list);
          },
          onError: (err) => {
            console.error('Stream chat error:', err);
          },
          onDone: (_, doneParts) => {
            if (doneParts && doneParts.length > 0) {
              finalCapturedParts = doneParts;
            }
          },
        },
        abortControllerRef.current.signal
      );

      const newAiMsg: Message = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: finalReply || streamingText,
        parts: finalCapturedParts.length > 0 ? [...finalCapturedParts] : undefined,
      };

      setMessages((prev) => [...prev, newAiMsg]);
      setStreamingText('');
      setStreamingParts([]);
    } catch (err: any) {
      console.error('handleSendMessage failed:', err);
      const errMsg: Message = {
        id: `ai-err-${Date.now()}`,
        role: 'assistant',
        content: `⚠️ 会话请求失败：${err?.message || '连接后端 LangGraph 服务失败，请检查服务是否正常启动。'}`,
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      {/* 左侧边栏 */}
      {!isSidebarCollapsed && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSession?.thread_id || null}
          isNewSessionDraft={isNewSessionDraft}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateSession}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onToggleCollapse={() => setIsSidebarCollapsed(true)}
          onOpenConfig={() => setIsConfigOpen(true)}
          isLiveServer={isLiveServer}
        />
      )}

      {/* 右侧主聊天区域 */}
      <ChatWindow
        messages={messages}
        contextSummary={contextSummary}
        onSendMessage={handleSendMessage}
        loading={loading}
        streamingText={streamingText}
        streamingParts={streamingParts}
        recommendations={recommendations}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed(false)}
        isNewSessionDraft={isNewSessionDraft}
      />

      {/* 服务配置弹窗 */}
      <ConfigModal
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        onSaved={() => loadSessions()}
      />
    </div>
  );
};
