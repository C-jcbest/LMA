import React, { useState, useRef, useEffect } from 'react';
import { Send, Plus, PanelLeftOpen, Sparkles, MessageCircle, ChevronRight, Square, ArrowDown, Archive } from 'lucide-react';
import { Message, MessagePart } from '../services/api';
import { MarkdownMessage } from './MarkdownMessage';
import { InlineToolCall } from './InlineToolCall';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThinkingBlock } from './ThinkingBlock';
import { SummaryCard } from './SummaryCard';
import { MessageActions } from './MessageActions';
import { ContextUsage, ContextUsageIndicator } from './ContextUsageIndicator';

interface ChatWindowProps {
  messages: Message[];
  contextSummary?: string;
  contextUsage?: ContextUsage;
  onSendMessage: (text: string) => void;
  threadLoading: boolean;
  runActive: boolean;
  stopReconciling: boolean;
  hasRunningTool: boolean;
  renderOptimisticStatus?: (messageId?: string) => React.ReactNode;
  recommendations?: string[];
  recommendationError?: string;
  errorMessage?: string;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isNewSessionDraft?: boolean;
  onStopGeneration?: () => void;
}

const MAX_LENGTH = 3000;

// 消息复制内容：有 parts 时只拼接文本片段（不含工具卡片），否则取正文
const getMessageText = (msg: Message): string => {
  if (msg.parts && msg.parts.length > 0) {
    return msg.parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.content)
      .join('\n\n');
  }
  return msg.content || '';
};

export const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  contextSummary,
  contextUsage,
  onSendMessage,
  threadLoading,
  runActive,
  stopReconciling,
  hasRunningTool,
  renderOptimisticStatus,
  recommendations = [],
  recommendationError = '',
  errorMessage = '',
  isSidebarCollapsed,
  onToggleSidebar,
  isNewSessionDraft = false,
  onStopGeneration,
}) => {
  const [inputText, setInputText] = useState('');
  const [showPromptsMenu, setShowPromptsMenu] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  };

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isPinnedRef.current = distance < 80;
    setShowJumpToBottom(distance > 200);
  };

  const handleJumpToBottom = () => {
    isPinnedRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom();
  };

  useEffect(() => {
    // 仅当用户停留在底部附近时自动跟随滚动，流式输出不打断上翻回看
    if (isPinnedRef.current) scrollToBottom();
  }, [messages, threadLoading, runActive, stopReconciling, recommendations]);

  const canSubmit = !threadLoading && !runActive && !stopReconciling;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || !canSubmit) return;
    onSendMessage(inputText.trim());
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const samplePrompts = [
    'ZJ-MS10 2025年10月监测数据稳定性如何',
    '查询 ZJ-MS04 站点周边近期的天气与降雨情况',
    '对比某监测点近期趋势与长期变化背景',
    '平台当前有权访问的分组和监测点数量是多少？',
  ];

  const lastMessage = messages[messages.length - 1];
  const waitingForAssistant = runActive && (!lastMessage || lastMessage.role === 'user');

  return (
    <div className="flex-1 h-full flex flex-col bg-white text-neutral-800 relative overflow-hidden">
      {/* 顶部轻量栏（折叠侧边栏时展示展开按钮） */}
      <div className="h-12 px-5 flex items-center justify-between shrink-0">
        {isSidebarCollapsed ? (
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 transition-colors"
            title="展开侧边栏"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        ) : (
          <div />
        )}
      </div>

      {/* 消息滚动区域 */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        aria-label="对话消息"
        className="flex-1 overflow-y-auto px-6 py-2 space-y-6"
      >
        {/* 历史压缩摘要与分割线（到达阈值或超限触发压缩后展示） */}
        {contextSummary && (
          <div className="max-w-4xl mx-auto w-full py-1">
            <div className="relative flex items-center justify-center my-3">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-dashed border-amber-300" />
              </div>
              <div className="relative flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-0.5 text-[11px] font-medium text-amber-800 shadow-xs">
                <Archive className="h-3 w-3 text-amber-600 shrink-0" />
                <span>历史对话已压缩至摘要 · 分割线之上为长期背景</span>
              </div>
            </div>
            <SummaryCard summary={contextSummary} />
          </div>
        )}

        {messages.map((msg, index) => {
          const isUser = msg.role === 'user';
          const isStreamingAssistant =
            runActive && index === messages.length - 1 && msg.role === 'assistant';
          const lastPart = msg.parts?.[msg.parts.length - 1];
          const settlingAfterTool =
            isStreamingAssistant &&
            !hasRunningTool &&
            lastPart?.type === 'tool' &&
            lastPart.toolCall.status === 'success';
          return (
            <div key={msg.id || index} className="group max-w-4xl mx-auto w-full">
              <div className={`flex items-start gap-3.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                {/* 头像 */}
                {isUser ? (
                  <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200/80 flex items-center justify-center shrink-0 text-xs font-semibold text-neutral-700 select-none">
                    ME
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
                    AI
                  </div>
                )}

                {/* 消息气泡主体 */}
                <div
                  className={`min-w-0 flex flex-col ${
                    isUser ? 'max-w-[75%] items-end' : 'flex-1 max-w-full items-start'
                  }`}
                >
                  <div
                    className={
                      isUser
                        ? 'bg-[#f3f4f6] text-neutral-800 text-sm px-4 py-2.5 rounded-2xl rounded-tr-sm shadow-sm'
                        : 'w-full text-neutral-800 text-sm py-0.5 space-y-2'
                    }
                  >
                    {isUser ? (
                      <MarkdownMessage content={msg.content || ''} />
                    ) : msg.parts && msg.parts.length > 0 ? (
                      // 嵌在消息流中按顺序展示各个文本块与行内工具调用
                      msg.parts.map((part, pIdx) => (
                        <React.Fragment key={pIdx}>
                          {part.type === 'tool' ? (
                            <InlineToolCall toolCall={part.toolCall} />
                          ) : part.type === 'thinking' ? (
                            <ThinkingBlock
                              thinking={part.thinking}
                              isActive={
                                isStreamingAssistant &&
                                part.thinking.duration_ms === undefined &&
                                pIdx === msg.parts!.length - 1
                              }
                            />
                          ) : (
                            <MarkdownMessage content={part.content} />
                          )}
                        </React.Fragment>
                      ))
                    ) : (
                      <MarkdownMessage content={msg.content || ''} />
                    )}
                    {settlingAfterTool && (
                      <ThinkingIndicator statusText="正在根据查询结果整理回答..." />
                    )}
                  </div>

                  {/* 消息底部工具栏：悬浮显示，当前仅复制 */}
                  <MessageActions
                    align={isUser ? 'right' : 'left'}
                    getText={() => getMessageText(msg)}
                    timestamp={msg.created_at}
                  />
                  {isUser && renderOptimisticStatus?.(msg.id)}
                </div>
              </div>
            </div>
          );
        })}

        {/* 下一步推荐动作：点击后自动发送 */}
        {canSubmit && recommendations.length > 0 && (
          <div className="max-w-4xl mx-auto w-full flex flex-wrap items-center gap-2 pl-11">
            <span className="text-[11px] text-neutral-400 select-none shrink-0">下一步</span>
            {recommendations.map((rec, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSendMessage(rec)}
                className="flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full border border-neutral-200 bg-white text-xs text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 transition-colors shadow-sm"
              >
                <ChevronRight className="w-3 h-3 text-indigo-500 shrink-0" />
                <span className="truncate">{rec}</span>
              </button>
            ))}
          </div>
        )}

        {canSubmit && recommendationError && (
          <div className="mx-auto w-full max-w-4xl pl-11 text-xs text-amber-700" role="status">
            {recommendationError}
          </div>
        )}

        {/* 尚未收到第一段权威消息时显示思考状态；消息到达后直接由 messages 渲染。 */}
        {waitingForAssistant && (
          <div className="max-w-4xl mx-auto w-full flex items-start gap-3.5">
            <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
              AI
            </div>
            <div className="flex-1 min-w-0 text-neutral-800 text-sm py-0.5 space-y-2">
              <div className="py-1">
                <ThinkingIndicator
                  statusText={
                    contextUsage?.usage_ratio && contextUsage.usage_ratio >= 0.8
                      ? '上下文接近触发线，正在执行历史压缩以释放窗口预算...'
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        )}

        {threadLoading && (
          <div className="mx-auto w-full max-w-4xl text-center text-xs text-neutral-400" role="status">
            正在加载会话…
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 底部悬浮卡片输入区 */}
      <div className="p-4 bg-white shrink-0 z-20">
        <div className="max-w-4xl mx-auto relative">
          {errorMessage && (
            <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              {errorMessage}
            </div>
          )}
          {stopReconciling && (
            <div className="mb-2 text-center text-xs text-neutral-500" role="status">正在结束本轮并同步记录…</div>
          )}
          {/* 位于输入框正上方，只有离开底部时出现。 */}
          {showJumpToBottom && (
            <button
              type="button"
              onClick={handleJumpToBottom}
              title="回到底部"
              aria-label="回到底部"
              className="absolute bottom-full left-1/2 mb-3 -translate-x-1/2 w-9 h-9 rounded-full bg-white border border-neutral-200 shadow-md flex items-center justify-center text-neutral-500 hover:text-neutral-800 hover:border-neutral-300 transition-colors"
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          )}
          {/* 快捷提问推荐浮层 */}
          {showPromptsMenu && (
            <div className="absolute bottom-full mb-2 left-0 w-80 bg-white border border-neutral-200 rounded-2xl shadow-xl p-2 z-30 space-y-1">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-indigo-500" />
                <span>推荐监测业务提问</span>
              </div>
              {samplePrompts.map((prompt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setInputText(prompt);
                    setShowPromptsMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs text-neutral-700 hover:bg-neutral-100 transition-colors line-clamp-1"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 bg-white border border-neutral-200/90 rounded-2xl px-3 py-2 shadow-[0_2px_15px_rgba(0,0,0,0.05)] focus-within:border-neutral-400 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.08)] transition-all"
          >
            {/* 左侧加号按钮 */}
            <button
              type="button"
              onClick={() => setShowPromptsMenu(!showPromptsMenu)}
              className="w-7 h-7 rounded-full bg-neutral-100 hover:bg-neutral-200/80 flex items-center justify-center text-neutral-600 transition-colors shrink-0"
              title="快捷提问与选项"
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* 输入框 */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              maxLength={MAX_LENGTH}
              disabled={threadLoading || runActive}
              placeholder="询问监测数据、变化趋势、降雨关联或场地环境..."
              className="flex-1 bg-transparent text-neutral-800 placeholder:text-neutral-400 text-sm outline-none resize-none leading-relaxed px-1 py-1 max-h-28"
            />

            {/* 字数统计 */}
            <div className="text-[11px] text-neutral-400 select-none shrink-0 px-1">
              {inputText.length}/{MAX_LENGTH}
            </div>

            {/* 上下文窗口用量：点击环形项目标识查看明细 */}
            <ContextUsageIndicator usage={contextUsage} />

            {/* Stop 只由当前官方 Run 状态控制；checkpoint 清理期间显示不可发送。 */}
            {runActive ? (
              <button
                type="button"
                onClick={onStopGeneration}
                className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-500 hover:text-neutral-800 flex items-center justify-center shrink-0 transition-all active:scale-95"
                title="停止生成"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim() || !canSubmit}
                className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#8793ea] to-[#99a4f4] hover:brightness-105 active:scale-95 text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-40 disabled:pointer-events-none shadow-sm"
                title={stopReconciling ? '正在结束本轮' : threadLoading ? '正在加载会话' : '发送 (Enter)'}
              >
                <Send className="w-3.5 h-3.5 fill-current" />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
