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
  // 当前流式输出所属会话（thread_id）：用于切换会话时阻止跨会话的状态写入
  const streamingOwnerRef = useRef<string | null>(null);

  // 中断当前流式请求（用户点击停止按钮）：半截内容会按普通消息落地，
  // 服务端 run 继续完成并写入 checkpoint，重新进入会话可见完整回答
  const stopGeneration = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  // 切换/新建/删除会话时调用：中断流式输出并清理全部相关状态，
  // 同时清空流式归属，阻止旧流的回调写入新会话的界面
  const stopStreaming = () => {
    stopGeneration();
    streamingOwnerRef.current = null;
    setLoading(false);
    setStreamingText('');
    setStreamingParts([]);
    setRecommendations([]);
  };

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
    stopStreaming();
    setIsNewSessionDraft(false);
    setActiveSession(session);
    loadMessages(session.thread_id);
  };

  const handleCreateSession = () => {
    stopStreaming();
    setIsNewSessionDraft(true);
    setActiveSession(null);
    setMessages([]);
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
    // 删除的是正在流式输出的会话时，先中断避免回调写入已删除的会话
    if (sessionId === streamingOwnerRef.current) {
      stopStreaming();
    }
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

    const ownerThreadId = targetSession.thread_id;
    // 本轮流式输出的会话归属检查：切换会话后旧流的所有回调不得再写入界面
    const isOwner = () => streamingOwnerRef.current === ownerThreadId;

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
    streamingOwnerRef.current = ownerThreadId;

    try {
      let finalCapturedParts: MessagePart[] = [];

      const finalReply = await streamChatWithLangGraph(
        targetSession.thread_id,
        userText,
        {
          onToken: (chunk) => {
            if (isOwner()) setStreamingText((prev) => prev + chunk);
          },
          onPartsUpdate: (parts) => {
            if (!isOwner()) return;
            finalCapturedParts = parts;
            setStreamingParts([...parts]);
          },
          onRecommendations: (list) => {
            if (isOwner()) setRecommendations(list);
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

      // 只有仍停留在发起会话时才落地最终消息；
      // 切换走的情况下服务端 run 已写入 checkpoint，重新进入会话会从历史加载
      if (isOwner()) {
        const newAiMsg: Message = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: finalReply,
          parts: finalCapturedParts.length > 0 ? [...finalCapturedParts] : undefined,
        };
        setMessages((prev) => [...prev, newAiMsg]);
        setStreamingText('');
        setStreamingParts([]);
      }
    } catch (err: any) {
      // 用户主动停止不算错误，静默收尾（半截内容已由上方落地或随会话历史恢复）
      const aborted =
        err?.name === 'AbortError' || abortControllerRef.current?.signal?.aborted;
      if (!aborted && isOwner()) {
        console.error('handleSendMessage failed:', err);
        const errMsg: Message = {
          id: `ai-err-${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 会话请求失败：${err?.message || '连接后端 LangGraph 服务失败，请检查服务是否正常启动。'}`,
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      if (isOwner()) {
        setLoading(false);
        streamingOwnerRef.current = null;
      }
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
        onStopGeneration={stopGeneration}
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
