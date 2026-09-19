import React, { useState, useRef, useEffect } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { Send, Plus, Square, Sparkles } from 'lucide-react';

export interface ComposerProps {
  disabled?: boolean;
  placeholder?: string;
}

const SAMPLE_PROMPTS = [
  '查询 SCWM-04 监测站近 3 天的位移变化与速率',
  '查询 SCWM-04 站点周边近期的天气与降雨情况',
  '对比某监测点近期趋势与长期变化背景',
  '平台当前有权访问的分组和监测点数量是多少？',
];

export const Composer: React.FC<ComposerProps> = ({
  disabled = false,
  placeholder = '询问监测数据、变化趋势、降雨关联或场地环境…',
}) => {
  const [showPromptsMenu, setShowPromptsMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (!showPromptsMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowPromptsMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPromptsMenu]);

  return (
    <ComposerPrimitive.Root className="relative w-full rounded-2xl border border-neutral-200/90 bg-white px-3 py-2 shadow-[0_2px_15px_rgba(0,0,0,0.05)] focus-within:border-neutral-400 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.08)] transition-all">
      {/* 快捷提问推荐浮层 */}
      {showPromptsMenu && (
        <div
          ref={menuRef}
          className="absolute bottom-full mb-2.5 left-0 w-80 bg-white border border-neutral-200 rounded-2xl shadow-xl p-2 z-30 space-y-1 animate-in fade-in duration-150"
        >
          <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-indigo-500" />
            <span>推荐监测业务提问</span>
          </div>
          {SAMPLE_PROMPTS.map((prompt, i) => (
            <ThreadPrimitive.Suggestion
              key={i}
              prompt={prompt}
              autoSend={false}
              method="replace"
              asChild
            >
              <button
                type="button"
                onClick={() => setShowPromptsMenu(false)}
                className="w-full text-left px-3 py-2 rounded-xl text-xs text-neutral-700 hover:bg-neutral-100 transition-colors line-clamp-1 cursor-pointer"
              >
                {prompt}
              </button>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* 左侧加号按钮 */}
        <button
          type="button"
          onClick={() => setShowPromptsMenu((prev) => !prev)}
          className="w-7 h-7 rounded-full bg-neutral-100 hover:bg-neutral-200/80 flex items-center justify-center text-neutral-600 transition-colors shrink-0 cursor-pointer mb-1"
          title="快捷业务提问模板"
          aria-label="快捷业务提问模板"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* 输入框：支持 IME 中文选词保护 */}
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          disabled={disabled}
          placeholder={placeholder}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && isComposingRef.current) {
              e.stopPropagation();
            }
          }}
          className="flex-1 max-h-36 min-h-[36px] resize-none border-0 bg-transparent px-2 py-1 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-hidden leading-relaxed"
        />

        {/* 右侧操作按钮 */}
        <div className="flex items-center gap-1.5 shrink-0 mb-0.5">
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <button
                type="button"
                className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-500 hover:text-neutral-800 flex items-center justify-center shrink-0 transition-all active:scale-95 cursor-pointer"
                title="停止生成"
                aria-label="停止生成"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>

          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button
                type="button"
                className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#8793ea] to-[#99a4f4] hover:brightness-105 active:scale-95 text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-40 disabled:pointer-events-none shadow-xs cursor-pointer"
                title="发送 (Enter)"
                aria-label="发送 (Enter)"
              >
                <Send className="w-3.5 h-3.5 fill-current" />
              </button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
