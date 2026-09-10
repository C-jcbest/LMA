import React, { useState, useRef, useEffect } from 'react';
import { Send, Plus, PanelLeftOpen, Sparkles, MessageCircle } from 'lucide-react';
import { Message, MessagePart } from '../services/api';
import { MarkdownMessage } from './MarkdownMessage';
import { InlineToolCall } from './InlineToolCall';
import { ThinkingIndicator } from './ThinkingIndicator';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (text: string) => void;
  loading: boolean;
  streamingText: string;
  streamingParts?: MessagePart[];
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isNewSessionDraft?: boolean;
}

const MAX_LENGTH = 3000;

export const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  onSendMessage,
  loading,
  streamingText,
  streamingParts = [],
  isSidebarCollapsed,
  onToggleSidebar,
  isNewSessionDraft = false,
}) => {
  const [inputText, setInputText] = useState('');
  const [showPromptsMenu, setShowPromptsMenu] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText, streamingParts, loading]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || loading) return;
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
      <div className="flex-1 overflow-y-auto px-6 py-2 space-y-6">
        {(isNewSessionDraft ||
          (messages.length === 0 && !streamingText && streamingParts.length === 0)) && (
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

        {messages.map((msg, index) => {
          const isUser = msg.role === 'user';
          return (
            <div key={msg.id || index} className="max-w-4xl mx-auto w-full">
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
                          ) : (
                            <MarkdownMessage content={part.content} />
                          )}
                        </React.Fragment>
                      ))
                    ) : (
                      <MarkdownMessage content={msg.content || ''} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* 正在生成中的统一 AI 消息单元 (内容按流式顺序实时嵌入渲染) */}
        {loading && (
          <div className="max-w-4xl mx-auto w-full flex items-start gap-3.5">
            <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
              AI
            </div>
            <div className="flex-1 min-w-0 text-neutral-800 text-sm py-0.5 space-y-2">
              {streamingParts.length > 0 ? (
                streamingParts.map((part, pIdx) => (
                  <React.Fragment key={pIdx}>
                    {part.type === 'tool' ? (
                      <InlineToolCall toolCall={part.toolCall} />
                    ) : (
                      <MarkdownMessage content={part.content} />
                    )}
                  </React.Fragment>
                ))
              ) : streamingText ? (
                <MarkdownMessage content={streamingText} />
              ) : (
                <div className="py-1">
                  <ThinkingIndicator />
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

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
              disabled={loading}
              placeholder="询问滑坡监测数据、气象降雨风险或计算判定方案..."
              className="flex-1 bg-transparent text-neutral-800 placeholder:text-neutral-400 text-sm outline-none resize-none leading-relaxed px-1 py-1 max-h-28"
            />

            {/* 字数统计 */}
            <div className="text-[11px] text-neutral-400 select-none shrink-0 px-1">
              {inputText.length}/{MAX_LENGTH}
            </div>

            {/* 发送按钮 */}
            <button
              type="submit"
              disabled={!inputText.trim() || loading}
              className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#8793ea] to-[#99a4f4] hover:brightness-105 active:scale-95 text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-40 disabled:pointer-events-none shadow-sm"
              title="发送 (Enter)"
            >
              <Send className="w-3.5 h-3.5 fill-current" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
