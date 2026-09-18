import React, { useState, useRef } from 'react';
import { Send, Plus, Square, Sparkles } from 'lucide-react';
import { ContextUsage, ContextUsageIndicator } from '../ContextUsageIndicator';

interface ComposerProps {
  onSendMessage: (text: string) => void;
  onStopGeneration?: () => void;
  runActive: boolean;
  threadLoading: boolean;
  contextUsage?: ContextUsage;
}

const MAX_LENGTH = 3000;
const CHAR_WARN_THRESHOLD = 2400; // 4.2: 只有字数接近上限时才显示计数

const samplePrompts = [
  'ZJ-MS10 2025年10月监测数据稳定性如何',
  '查询 ZJ-MS04 站点周边近期的天气与降雨情况',
  '对比某监测点近期趋势与长期变化背景',
  '平台当前有权访问的分组和监测点数量是多少？',
];

export const Composer: React.FC<ComposerProps> = ({
  onSendMessage,
  onStopGeneration,
  runActive,
  threadLoading,
  contextUsage,
}) => {
  const [inputText, setInputText] = useState('');
  const [showPromptsMenu, setShowPromptsMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  const canSubmit = !threadLoading && !runActive;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isComposingRef.current) return;
    if (!inputText.trim() || !canSubmit) return;
    onSendMessage(inputText.trim());
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isComposingRef.current) return; // 4.2: 中文输入法选词不误触发送
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const getDisabledReason = () => {
    if (threadLoading) return '正在加载会话...';
    if (runActive) return '智能体正在分析中，可点击停止';
    if (!inputText.trim()) return '请输入问题 (Enter 发送)';
    return '发送 (Enter)';
  };

  return (
    <div className="p-4 bg-white shrink-0 z-20">
      <div className="max-w-4xl mx-auto relative">
        {/* 快捷提问推荐浮层 */}
        {showPromptsMenu && (
          <div className="absolute bottom-full mb-2 left-0 w-80 bg-white border border-neutral-200 rounded-2xl shadow-xl p-2 z-30 space-y-1 animate-in fade-in duration-150">
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
                className="w-full text-left px-3 py-2 rounded-xl text-xs text-neutral-700 hover:bg-neutral-100 transition-colors line-clamp-1 cursor-pointer"
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
            className="w-7 h-7 rounded-full bg-neutral-100 hover:bg-neutral-200/80 flex items-center justify-center text-neutral-600 transition-colors shrink-0 cursor-pointer"
            title="快捷业务提问模板"
            aria-label="快捷业务提问模板"
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
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            maxLength={MAX_LENGTH}
            disabled={threadLoading || runActive}
            placeholder="询问监测数据、变化趋势、降雨关联或场地环境..."
            className="flex-1 bg-transparent text-neutral-800 placeholder:text-neutral-400 text-sm outline-none resize-none leading-relaxed px-1 py-1 max-h-28"
          />

          {/* 字数统计：仅接近上限时才展示，减少视觉干扰 */}
          {inputText.length >= CHAR_WARN_THRESHOLD && (
            <div className="text-[11px] text-amber-600 font-mono select-none shrink-0 px-1 animate-in fade-in">
              {inputText.length}/{MAX_LENGTH}
            </div>
          )}

          {/* 上下文用量指示器 */}
          <ContextUsageIndicator usage={contextUsage} />

          {/* 统一 Send / Stop 按钮插槽 */}
          {runActive ? (
            <button
              type="button"
              onClick={onStopGeneration}
              className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-500 hover:text-neutral-800 flex items-center justify-center shrink-0 transition-all active:scale-95 cursor-pointer"
              title="停止生成"
              aria-label="停止生成"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim() || !canSubmit}
              className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#8793ea] to-[#99a4f4] hover:brightness-105 active:scale-95 text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-40 disabled:pointer-events-none shadow-xs cursor-pointer"
              title={getDisabledReason()}
              aria-label={getDisabledReason()}
            >
              <Send className="w-3.5 h-3.5 fill-current" />
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
