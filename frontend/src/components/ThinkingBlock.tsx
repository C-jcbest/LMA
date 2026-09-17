import React, { useState } from 'react';
import { BrainCircuit, ChevronRight } from 'lucide-react';

interface ThinkingBlockProps {
  content: string;
  isActive?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isActive = false }) => {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled !== null ? userToggled : isActive;

  return (
    <div className="thinking-block my-2 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setUserToggled((previous) => (previous !== null ? !previous : !isActive))}
        className="thinking-block__trigger"
      >
        <span className="thinking-block__icon">
          <BrainCircuit className={`h-3.5 w-3.5 ${isActive ? 'animate-pulse text-neutral-600' : ''}`} />
        </span>
        <span className="font-medium text-neutral-700">{isActive ? '正在思考' : '已思考'}</span>
        <ChevronRight
          className={`h-3.5 w-3.5 text-neutral-400 transition-transform duration-200 ${
            expanded ? 'rotate-90 text-neutral-600' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className="thinking-block__content" role="region" aria-label="模型思考过程">
          <div className="thinking-block__label flex items-center justify-between">
            <span>{isActive ? '正在深度思考…' : '模型思考过程'}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 text-[10px] font-normal normal-case text-neutral-400">
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
