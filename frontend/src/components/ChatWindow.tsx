import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Plus,
  PanelLeftOpen,
  Sparkles,
  ChevronRight,
  Square,
  ArrowDown,
  Archive,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import type { AnyStream } from '@langchain/react';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { MarkdownMessage } from './MarkdownMessage';
import { InlineToolCall } from './InlineToolCall';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThinkingBlock } from './ThinkingBlock';
import { groupMessagesForDisplay } from './messageDisplay';
import { SummaryCard } from './SummaryCard';
import { MessageActions } from './MessageActions';
import { ContextUsage, ContextUsageIndicator } from './ContextUsageIndicator';
import { RunFailureCard } from './RunFailureCard';
import { ErrorBoundary } from './ErrorBoundary';

interface ChatWindowProps {
  stream?: AnyStream;
  messages: BaseMessage[];
  toolCalls?: AssembledToolCall[];
  contextSummary?: string;
  contextUsage?: ContextUsage;
  onSendMessage: (text: string) => void;
  threadLoading: boolean;
  runActive: boolean;
  stopReconciling: boolean;
  renderOptimisticStatus?: (messageId?: string) => React.ReactNode;
  recommendations?: string[];
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isNewSessionDraft?: boolean;
  onStopGeneration?: () => void;

  // 分层错误 props
  runError?: boolean;
  onRegenerate?: (checkpointId: string, message: BaseMessage) => void;
  onDismissRunError?: () => void;
  hydrationError?: boolean;
  onReloadThread?: () => void;
  onDismissHydrationError?: () => void;
  stopError?: boolean;
  onRetryStop?: () => void;
}

const MAX_LENGTH = 3000;

const getCreatedAt = (message: BaseMessage): string | undefined => {
  const value = message.additional_kwargs.created_at;
  return typeof value === 'string' ? value : undefined;
};

const getAssistantText = (messages: Array<AIMessage | ToolMessage>): string =>
  messages
    .filter((message): message is AIMessage => AIMessage.isInstance(message))
    .flatMap((message) => message.contentBlocks)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

export const ChatWindow: React.FC<ChatWindowProps> = ({
  stream,
  messages,
  toolCalls = [],
  contextSummary,
  contextUsage,
  onSendMessage,
  threadLoading,
  runActive,
  stopReconciling,
  renderOptimisticStatus,
  recommendations = [],
  isSidebarCollapsed,
  onToggleSidebar,
  isNewSessionDraft = false,
  onStopGeneration,
  runError = false,
  onRegenerate,
  onDismissRunError,
  hydrationError = false,
  onReloadThread,
  onDismissHydrationError,
  stopError = false,
  onRetryStop,
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
  }, [messages, threadLoading, runActive, stopReconciling, recommendations, runError, hydrationError, stopError]);

  const canSubmit = !threadLoading && !runActive && !stopReconciling && !stopError;

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

  const displayTurns = groupMessagesForDisplay(messages);
  const lastTurn = displayTurns[displayTurns.length - 1];
  const waitingForAssistant = runActive && (!lastTurn || lastTurn.kind === 'human');
  const liveToolCalls = new Map(toolCalls.map((toolCall) => [toolCall.callId, toolCall]));

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

        {/* 会话加载失败状态卡 */}
        {hydrationError && (
          <div className="max-w-4xl mx-auto w-full my-3 p-3 rounded-xl border border-amber-200 bg-amber-50/70 text-xs text-neutral-800 flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>会话加载失败</span>
            </div>
            <div className="flex items-center gap-2">
              {onReloadThread && (
                <button
                  type="button"
                  onClick={onReloadThread}
                  className="px-2.5 py-1 rounded-lg bg-white border border-neutral-200 text-xs font-medium text-neutral-700 hover:bg-neutral-50 transition-colors shadow-xs"
                >
                  重新加载
                </button>
              )}
              {onDismissHydrationError && (
                <button
                  type="button"
                  onClick={onDismissHydrationError}
                  className="px-2 py-1 rounded-lg text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
                >
                  关闭
                </button>
              )}
            </div>
          </div>
        )}

        {displayTurns.map((turn, index) => {
          const isUser = turn.kind === 'human';
          const turnMessages = turn.kind === 'assistant' ? turn.messages : [];
          const toolMessages = new Map(
            turnMessages
              .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
              .map((message) => [message.tool_call_id, message])
          );
          const aiMessages = turnMessages.filter(
            (message): message is AIMessage => AIMessage.isInstance(message)
          );
          const lastAIMessage = aiMessages[aiMessages.length - 1];
          const isStreamingAssistant = runActive && index === displayTurns.length - 1 && !isUser;
          const message = isUser ? turn.message : lastAIMessage;
          const turnKey = isUser ? turn.message.id : turnMessages[0]?.id;
          const messageText = isUser ? turn.message.text : getAssistantText(turnMessages);

          return (
            <div key={turnKey || index} className="group max-w-4xl mx-auto w-full">
              <div className={`flex items-start gap-3.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                {isUser ? (
                  <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200/80 flex items-center justify-center shrink-0 text-xs font-semibold text-neutral-700 select-none">
                    ME
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
                    AI
                  </div>
                )}

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
                      <MarkdownMessage content={turn.message.text} />
                    ) : (
                      aiMessages.map((aiMessage) => {
                        const blocks = aiMessage.contentBlocks;
                        const hasStandardReasoning = blocks.some((block) => block.type === 'reasoning');
                        const compatibilityReasoning = aiMessage.additional_kwargs.reasoning_content;
                        const hasFollowupContent = blocks.some(
                          (block) =>
                            (block.type === 'text' && Boolean(block.text.trim())) || block.type === 'tool_call'
                        );
                        return (
                          <React.Fragment key={aiMessage.id || turnMessages.indexOf(aiMessage)}>
                            {!hasStandardReasoning &&
                              typeof compatibilityReasoning === 'string' &&
                              compatibilityReasoning.trim() && (
                                <ThinkingBlock
                                  content={compatibilityReasoning}
                                  isActive={
                                    isStreamingAssistant &&
                                    aiMessage === lastAIMessage &&
                                    !hasFollowupContent
                                  }
                                />
                              )}
                            {blocks.map((block, blockIndex) => {
                              if (block.type === 'text') {
                                return block.text ? (
                                  <MarkdownMessage key={blockIndex} content={block.text} />
                                ) : null;
                              }
                              if (block.type === 'reasoning') {
                                return block.reasoning ? (
                                  <ThinkingBlock
                                    key={blockIndex}
                                    content={block.reasoning}
                                    isActive={
                                      isStreamingAssistant &&
                                      aiMessage === lastAIMessage &&
                                      blockIndex === blocks.length - 1
                                    }
                                  />
                                ) : null;
                              }
                              if (block.type === 'tool_call') {
                                return (
                                  <ErrorBoundary key={block.id || blockIndex} fallbackTitle="工具结果渲染异常">
                                    <InlineToolCall
                                      toolCall={block}
                                      liveToolCall={block.id ? liveToolCalls.get(block.id) : undefined}
                                      toolMessage={block.id ? toolMessages.get(block.id) : undefined}
                                    />
                                  </ErrorBoundary>
                                );
                              }
                              return null;
                            })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>

                  <MessageActions
                    align={isUser ? 'right' : 'left'}
                    getText={() => messageText}
                    timestamp={message ? getCreatedAt(message) : undefined}
                  />
                  {isUser && renderOptimisticStatus?.(turn.message.id)}
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

        {/* 主 Run 失败轻量卡（在回答位置显示，通过官方 useMessageMetadata 提取 parentCheckpointId 重试） */}
        {runError && !runActive && stream && (
          <RunFailureCard
            stream={stream}
            lastHumanMessage={
              [...(stream.messages || [])]
                .reverse()
                .find((message) => HumanMessage.isInstance(message))
            }
            onRegenerate={(checkpointId, message) => onRegenerate?.(checkpointId, message)}
            onDismiss={() => onDismissRunError?.()}
          />
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
          {/* Stop 收尾同步异常轻量提示：阻止继续发送，仅提供重试 */}
          {stopError && (
            <div className="mb-2 max-w-4xl mx-auto flex items-center justify-between p-2.5 rounded-xl border border-amber-200 bg-amber-50/80 text-xs text-amber-900 shadow-xs">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>停止处理未完成 · 重试</span>
              </div>
              <div className="flex items-center gap-2">
                {onRetryStop && (
                  <button
                    type="button"
                    onClick={onRetryStop}
                    className="px-2.5 py-1 rounded-lg bg-white border border-amber-200 text-xs font-medium text-amber-800 hover:bg-amber-100/50 transition-colors shadow-xs"
                  >
                    重试
                  </button>
                )}
              </div>
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
                title={stopReconciling ? '正在结束本轮' : stopError ? '停止未完成，请重试' : threadLoading ? '正在加载会话' : '发送 (Enter)'}
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
