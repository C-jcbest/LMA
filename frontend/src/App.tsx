import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { ConfigModal } from './components/ConfigModal';
import {
  ThreadSession,
  Message,
  MessagePart,
  ThreadStreamState,
  getSessions,
  createSession,
  renameSession,
  deleteSession,
  getSessionMessages,
  streamChatWithLangGraph,
  cancelRun,
  generateSessionTitle,
} from './services/api';

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [activeSession, setActiveSession] = useState<ThreadSession | null>(null);
  const [isNewSessionDraft, setIsNewSessionDraft] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextSummary, setContextSummary] = useState<string>('');
  const [recommendations, setRecommendations] = useState<string[]>([]);
  // 按 thread_id 隔离的流式缓冲：切换会话不中断生成，切回原会话恢复流式显示
  const [streamStates, setStreamStates] = useState<Record<string, ThreadStreamState>>({});
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isLiveServer, setIsLiveServer] = useState(false);

  // 每个会话独立的 AbortController；删除会话/点击停止时按 thread 中断
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // 每个会话进行中 run 的 run_id（run 创建时从响应回调获得），停止生成时取消服务端 run
  const runIdsRef = useRef<Map<string, string>>(new Map());
  // 非激活会话生成失败时暂存错误信息，切回该会话时展示
  const pendingErrorsRef = useRef<Record<string, string>>({});

  const activeThreadId = isNewSessionDraft ? null : activeSession?.thread_id ?? null;
  // 激活会话镜像 ref：流式回调与落地判断在异步闭包中进行，state 会过期
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  // 流式状态镜像 ref：loadMessages 等异步流程中判断生成是否仍在进行
  const streamStatesRef = useRef(streamStates);
  streamStatesRef.current = streamStates;

  const activeStream = activeThreadId ? streamStates[activeThreadId] : undefined;
  const isGeneratingActive = !!activeStream;
  const generatingThreadIds = Object.keys(streamStates);

  const updateStreamState = (
    threadId: string,
    updater: (prev: ThreadStreamState) => ThreadStreamState
  ) => {
    setStreamStates((prev) => {
      const base = prev[threadId] ?? { parts: [], text: '' };
      return { ...prev, [threadId]: updater(base) };
    });
  };

  const clearStreamState = (threadId: string) => {
    setStreamStates((prev) => {
      if (!(threadId in prev)) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  };

  // 用户点击停止按钮：只中断当前查看会话的生成。
  // 本地中断流消费并把半截内容落地；同时调用服务端 cancel API 真正终止 run，
  // 服务端不再继续生成（已完成的步骤保留在会话历史，半截正文不写入 checkpoint）
  const stopGeneration = () => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    abortControllersRef.current.get(threadId)?.abort();
    abortControllersRef.current.delete(threadId);
    const runId = runIdsRef.current.get(threadId);
    if (runId) {
      runIdsRef.current.delete(threadId);
      void cancelRun(threadId, runId);
    }
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

  // 截掉最后一条用户消息之后的全部内容：生成中的回复其已完成部分
  // （工具调用轮等）可能已写入服务端 checkpoint，与前端流式缓冲重叠，
  // 这部分交给流式缓冲统一渲染，避免切回会话时同一回复重复显示
  const truncateAfterLastUser = (msgs: Message[]): Message[] => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return msgs.slice(0, i + 1);
    }
    return msgs;
  };

  // 最后一条用户消息之后是否已有带正文的助手回答
  const hasReplyAfterLastUser = (msgs: Message[]): boolean => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return false;
      if (msgs[i].role === 'assistant' && (msgs[i].content || '').trim()) return true;
    }
    return false;
  };

  const loadMessages = async (threadId: string, allowRefetch = true) => {
    try {
      const res = await getSessionMessages(threadId);
      // 加载期间用户已切走则不覆盖当前会话的消息
      if (activeThreadIdRef.current !== threadId) return;
      const streaming = threadId in streamStatesRef.current;
      let msgs = res.messages;
      if (streaming) {
        msgs = truncateAfterLastUser(msgs);
      } else if (allowRefetch && msgs.length > 0 && !hasReplyAfterLastUser(msgs)) {
        // 流刚结束但拿到的是未含最终回答的中间 checkpoint（加载与落地竞态），
        // 重拉一次取完整历史；仅重试一次，服务端确无回答时如实展示
        return loadMessages(threadId, false);
      }
      setMessages(msgs);
      setContextSummary(res.contextSummary || '');
      setRecommendations(res.recommendations || []);
      // 切回时展示该会话在离线期间的失败信息（如有）
      const pendingError = pendingErrorsRef.current[threadId];
      if (pendingError) {
        delete pendingErrorsRef.current[threadId];
        setMessages((prev) => [
          ...prev,
          { id: `ai-err-${Date.now()}`, role: 'assistant', content: pendingError },
        ]);
      }
    } catch (e) {
      console.warn('loadMessages err:', e);
    }
  };

  // 切换会话不中断进行中的生成：目标会话若在生成中，
  // 历史照常加载，流式块由 streamStates 恢复并继续实时显示
  const handleSelectSession = (session: ThreadSession) => {
    setIsNewSessionDraft(false);
    setActiveSession(session);
    setRecommendations([]);
    loadMessages(session.thread_id);
  };

  const handleCreateSession = () => {
    setIsNewSessionDraft(true);
    setActiveSession(null);
    setMessages([]);
    setContextSummary('');
    setRecommendations([]);
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
    // 删除生成中的会话：先中断本地流并清缓冲、取消服务端 run，避免孤儿回调写入已删除的会话
    abortControllersRef.current.get(sessionId)?.abort();
    abortControllersRef.current.delete(sessionId);
    const runId = runIdsRef.current.get(sessionId);
    if (runId) {
      runIdsRef.current.delete(sessionId);
      void cancelRun(sessionId, runId);
    }
    clearStreamState(sessionId);
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
    if (!userText.trim() || isGeneratingActive) return;

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

    const threadId = targetSession.thread_id;

    const newUserMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userText,
    };

    setMessages((prev) => [...prev, newUserMsg]);
    setRecommendations([]);
    updateStreamState(threadId, () => ({ parts: [], text: '' }));

    const controller = new AbortController();
    abortControllersRef.current.set(threadId, controller);

    try {
      let finalCapturedParts: MessagePart[] = [];
      let streamRecs: string[] = [];

      const finalReply = await streamChatWithLangGraph(
        threadId,
        userText,
        {
          onToken: (chunk) => {
            updateStreamState(threadId, (s) => ({ ...s, text: s.text + chunk }));
          },
          onPartsUpdate: (parts) => {
            // 同步捕获最新片段：用户停止生成（abort 不触发 onDone）时，
            // 半截消息仍能带上已完成的工具卡片
            finalCapturedParts = parts;
            updateStreamState(threadId, (s) => ({ ...s, parts }));
          },
          onRecommendations: (list) => {
            streamRecs = list;
            if (activeThreadIdRef.current === threadId) setRecommendations(list);
          },
          onRunStarted: (runId) => {
            runIdsRef.current.set(threadId, runId);
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
        controller.signal
      );

      // 落地：正在查看该会话时追加最终消息；不在查看时仅清缓冲——
      // 服务端 checkpoint 已含完整回答，切回时 loadMessages 会拉到完整历史
      if (activeThreadIdRef.current === threadId) {
        const newAiMsg: Message = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: finalReply,
          parts: finalCapturedParts.length > 0 ? [...finalCapturedParts] : undefined,
        };
        setMessages((prev) => {
          // 防重：与并发 loadMessages 竞态时，尾部已有相同内容的助手消息则不重复追加
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.content === newAiMsg.content) return prev;
          return [...prev, newAiMsg];
        });
        if (streamRecs.length > 0) setRecommendations(streamRecs);
      }
      clearStreamState(threadId);
    } catch (err: any) {
      // 用户主动停止不算错误：api 在 abort 时返回半截内容并已按上方逻辑落地
      const aborted = err?.name === 'AbortError' || controller.signal.aborted;
      if (!aborted) {
        const errMessage = `⚠️ 会话请求失败：${
          err?.message || '连接后端 LangGraph 服务失败，请检查服务是否正常启动。'
        }`;
        if (activeThreadIdRef.current === threadId) {
          setMessages((prev) => [
            ...prev,
            { id: `ai-err-${Date.now()}`, role: 'assistant', content: errMessage },
          ]);
        } else {
          // 不在查看的会话失败：暂存错误信息，切回时展示
          pendingErrorsRef.current[threadId] = errMessage;
        }
        clearStreamState(threadId);
      }
    } finally {
      abortControllersRef.current.delete(threadId);
      runIdsRef.current.delete(threadId);
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

      {/* 右侧主聊天区域 */}
      <ChatWindow
        messages={messages}
        contextSummary={contextSummary}
        onSendMessage={handleSendMessage}
        isGenerating={isGeneratingActive}
        streamState={activeStream}
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
