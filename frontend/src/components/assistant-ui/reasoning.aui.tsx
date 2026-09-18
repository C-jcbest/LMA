import React, { useState } from 'react';
import type { ReasoningMessagePartProps } from '@assistant-ui/react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';

export const Reasoning: React.FC<ReasoningMessagePartProps> = ({ text, status }) => {
  const [isOpen, setIsOpen] = useState(false);
  const isRunning = status?.type === 'running';

  if (!text && !isRunning) return null;

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="thinking-block__trigger inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 transition-colors py-1 px-2 rounded-lg bg-neutral-100/60 hover:bg-neutral-100 cursor-pointer select-none"
      >
        <span className="thinking-block__icon w-4 h-4 rounded-full bg-neutral-200/80 flex items-center justify-center text-neutral-600">
          <Sparkles className="w-2.5 h-2.5" />
        </span>
        <span className="font-medium">
          {isRunning ? '思考分析中…' : '深度思考'}
        </span>
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-neutral-400" />
        ) : (
          <ChevronRight className="w-3 h-3 text-neutral-400" />
        )}
      </button>

      {isOpen && (
        <div className="thinking-block__content mt-1.5 pl-3 border-l-2 border-neutral-300 py-1.5 text-xs text-neutral-600 font-serif leading-relaxed bg-linear-to-r from-neutral-50/80 to-stone-50/40 rounded-r-lg">
          <div className="thinking-block__label text-[10px] font-sans font-bold text-neutral-400 tracking-wider uppercase mb-1">
            分析批注
          </div>
          <div className="whitespace-pre-wrap">{text || '思考进行中…'}</div>
        </div>
      )}
    </div>
  );
};
