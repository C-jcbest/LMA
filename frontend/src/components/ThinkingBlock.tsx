import React, { useState } from 'react';
import { BrainCircuit, ChevronRight } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isActive?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isActive = false }) => {
  // 3.8: streaming 与 finished 均默认折叠，用户可手动点击展开
  const [expanded, setExpanded] = useState(false);

  // 空 reasoning 不渲染任何占位
  if (!content || !content.trim()) {
    return null;
  }

  return (
    <div className="thinking-block my-2 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="thinking-block__trigger flex items-center gap-2 py-1 px-2 -ml-1 rounded-md text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/80 cursor-pointer transition-colors select-none"
      >
        <span className="thinking-block__icon">
          <BrainCircuit
            className={`h-3.5 w-3.5 ${isActive ? 'animate-pulse text-indigo-500' : 'text-neutral-400'}`}
          />
        </span>
        <span className="font-medium text-neutral-600">
          {isActive ? '正在思考…' : '已思考'}
        </span>
        {isActive && (
          <span className="inline-flex items-center gap-1 text-[10px] font-normal text-neutral-400">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
          </span>
        )}
        <ChevronRight
          className={`h-3.5 w-3.5 text-neutral-400 transition-transform duration-200 ${
            expanded ? 'rotate-90 text-neutral-600' : ''
          }`}
        />
      </button>

      {expanded && (
        <div
          className="thinking-block__content mt-1.5 p-3 rounded-xl border border-neutral-200/80 bg-neutral-50/60 text-xs text-neutral-600 font-mono leading-relaxed max-w-3xl animate-in fade-in duration-150"
          role="region"
          aria-label="模型思考过程"
        >
          <div className="thinking-block__label flex items-center justify-between pb-2 mb-2 border-b border-neutral-200/60 text-[11px] font-sans font-medium text-neutral-400">
            <span>{isActive ? '正在深度思考…' : '模型思考过程'}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 text-[10px] font-normal text-neutral-400">
                <span className="w-1 h-1 rounded-full bg-neutral-400 animate-pulse" />
                思考中
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap break-words">{content}</div>
        </div>
      )}
    </div>
  );
};
