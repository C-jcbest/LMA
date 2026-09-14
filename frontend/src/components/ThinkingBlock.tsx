import React, { useEffect, useState } from 'react';
import { BrainCircuit, ChevronRight, Clock3 } from 'lucide-react';
import { ThinkingInfo } from '../services/api';

interface ThinkingBlockProps {
  thinking: ThinkingInfo;
  isActive?: boolean;
}

const formatDuration = (durationMs: number): string => {
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
};

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, isActive = false }) => {
  // 正在思考时（isActive）默认展开以便流式实时查看；用户主动点击后遵从用户折叠/展开意愿
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const [liveDurationMs, setLiveDurationMs] = useState(0);

  const expanded = userToggled !== null ? userToggled : isActive;

  useEffect(() => {
    if (!isActive || thinking.duration_ms !== undefined) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setLiveDurationMs(Date.now() - startedAt), 100);
    return () => window.clearTimeout(timer);
  }, [isActive, thinking.duration_ms]);

  const durationMs = thinking.duration_ms ?? (isActive ? liveDurationMs : undefined);

  return (
    <div className="thinking-block my-2 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setUserToggled((prev) => (prev !== null ? !prev : !isActive))}
        className="thinking-block__trigger"
      >
        <span className="thinking-block__icon">
          <BrainCircuit className={`h-3.5 w-3.5 ${isActive ? 'animate-pulse text-neutral-600' : ''}`} />
        </span>
        <span className="font-medium text-neutral-700">{isActive ? '正在思考' : '已思考'}</span>
        {durationMs !== undefined && (
          <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-neutral-400">
            <Clock3 className="h-3 w-3" />
            {formatDuration(durationMs)}
          </span>
        )}
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
          <div className="whitespace-pre-wrap break-words">{thinking.content}</div>
        </div>
      )}
    </div>
  );
};
