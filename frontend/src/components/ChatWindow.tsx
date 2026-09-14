import React, { useState, useRef, useEffect } from 'react';
import { Send, Plus, PanelLeftOpen, Sparkles, MessageCircle, ChevronRight, Square, ArrowDown } from 'lucide-react';
import { Message, MessagePart } from '../services/api';
import { MarkdownMessage } from './MarkdownMessage';
import { InlineToolCall } from './InlineToolCall';
import { ThinkingIndicator } from './ThinkingIndicator';
import { SummaryCard } from './SummaryCard';
import { MessageActions } from './MessageActions';

interface ChatWindowProps {
  messages: Message[];
  contextSummary?: string;
  onSendMessage: (text: string) => void;
  /** 当前查看会话是否正在生成回复 */
  isGenerating: boolean;
  recommendations?: string[];
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
  onSendMessage,
  isGenerating,
  recommendations = [],
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
  }, [messages, isGenerating]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isGenerating) return;
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
    '北京今日天气',
    '平台当前有权访问的分组和监测点数量是多少？',
  ];

  const lastMessage = messages[messages.length - 1];
  const waitingForAssistant = isGenerating && (!lastMessage || lastMessage.role === 'user');

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
        className="flex-1 overflow-y-auto px-6 py-2 space-y-6"
      >
        {(isNewSessionDraft || messages.length === 0) && (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-neutral-400 select-none">
            <div className="w-12 h-12 rounded-2xl bg-neutral-100 flex items-center justify-center mb-3">
              <MessageCircle className="w-6 h-6 text-neutral-400" />
            </div>
            <h3 className="text-sm font-semibold text-neutral-700">开启滑坡连续监测业务调查</h3>
            <p className="text-xs text-neutral-400 mt-1 max-w-sm">
              在下方输入问题，或点击左下角加号选择预置指令，智能体将连接北斗平台与监测算法进行专业分析。
            </p>
          </div>
        )}

        {/* 历史压缩摘要卡（上下文压缩发生后展示） */}
        {contextSummary && <SummaryCard summary={contextSummary} />}

        {messages.map((msg, index) => {
          const isUser = msg.role === 'user';
          const isStreamingAssistant =
            isGenerating && index === messages.length - 1 && msg.role === 'assistant';
          let lastTextPartIndex = -1;
          if (isStreamingAssistant && msg.parts) {
            for (let i = msg.parts.length - 1; i >= 0; i--) {
              if (msg.parts[i].type === 'text') {
                lastTextPartIndex = i;
                break;
              }
            }
          }
          const lastPart = msg.parts?.[msg.parts.length - 1];
          const settlingAfterTool =
            isStreamingAssistant &&
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
                          ) : pIdx === lastTextPartIndex ? (
                            <div className="streaming-cursor">
                              <MarkdownMessage content={part.content} />
                            </div>
                          ) : (
                            <MarkdownMessage content={part.content} />
                          )}
                        </React.Fragment>
                      ))
                    ) : (
                      <div className={isStreamingAssistant ? 'streaming-cursor' : undefined}>
                        <MarkdownMessage content={msg.content || ''} />
                      </div>
                    )}
                    {settlingAfterTool && (
                      <ThinkingIndicator statusText="正在根据查询结果整理回答..." />
                    )}
                  </div>

                  {/* 消息底部工具栏：悬浮显示，当前仅复制 */}
                  <MessageActions
                    align={isUser ? 'right' : 'left'}
                    getText={() => getMessageText(msg)}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {/* 下一步推荐动作：点击后自动发送 */}
        {!isGenerating && recommendations.length > 0 && (
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

        {/* 尚未收到第一段权威消息时显示思考状态；消息到达后直接由 messages 渲染。 */}
        {waitingForAssistant && (
          <div className="max-w-4xl mx-auto w-full flex items-start gap-3.5">
            <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
              AI
            </div>
            <div className="flex-1 min-w-0 text-neutral-800 text-sm py-0.5 space-y-2">
              <div className="py-1">
                <ThinkingIndicator />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 回到底部悬浮按钮（用户上翻后显示） */}
      {showJumpToBottom && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          title="回到底部"
          className="absolute bottom-32 right-8 z-20 w-9 h-9 rounded-full bg-white border border-neutral-200 shadow-md flex items-center justify-center text-neutral-500 hover:text-neutral-800 transition-colors"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      {/* 底部悬浮卡片输入区 */}
      <div className="p-4 bg-white shrink-0 z-20">
        <div className="max-w-4xl mx-auto relative">
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
              disabled={isGenerating}
              placeholder="询问滑坡监测数据、气象降雨风险或计算判定方案..."
              className="flex-1 bg-transparent text-neutral-800 placeholder:text-neutral-400 text-sm outline-none resize-none leading-relaxed px-1 py-1 max-h-28"
            />

            {/* 字数统计 */}
            <div className="text-[11px] text-neutral-400 select-none shrink-0 px-1">
              {inputText.length}/{MAX_LENGTH}
            </div>

            {/* 发送 / 停止按钮：生成中时变为停止按钮 */}
            {isGenerating ? (
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
                disabled={!inputText.trim()}
                className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#8793ea] to-[#99a4f4] hover:brightness-105 active:scale-95 text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-40 disabled:pointer-events-none shadow-sm"
                title="发送 (Enter)"
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
