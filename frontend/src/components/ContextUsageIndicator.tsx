import React, { useEffect, useRef, useState } from 'react';
import { Mountain } from 'lucide-react';

export interface ContextUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_limit_tokens?: number;
  remaining_tokens?: number | null;
  usage_ratio?: number | null;
  trigger_tokens?: number;
  estimated_fixed_input_tokens?: number;
  estimated_history_tokens?: number;
  accounting_difference_tokens?: number;
  output_reserve_tokens?: number;
  safety_margin_tokens?: number;
  counter?: 'provider_reported';
  model?: string;
}

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString('zh-CN');
};


export const ContextUsageIndicator: React.FC<{ usage?: ContextUsage }> = ({ usage }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const isComplete =
    usage?.counter === 'provider_reported' &&
    typeof usage.input_tokens === 'number' &&
    typeof usage.context_limit_tokens === 'number' &&
    usage.context_limit_tokens > 0 &&
    typeof usage.usage_ratio === 'number';
  if (!isComplete) return null;

  const ratio = Math.max(0, Math.min(1, usage.usage_ratio as number));
  const percent = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 12;
  const tone = ratio >= 0.8 ? '#dc2626' : ratio >= 0.6 ? '#d97706' : '#6366f1';

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none"
        title={`上下文预算已用 ${percent}%`}
        aria-label={`上下文预算已用 ${percent}%`}
        aria-expanded={isOpen}
      >
        <svg className="absolute inset-0 h-8 w-8 -rotate-90" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="12" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
          <circle
            cx="16"
            cy="16"
            r="12"
            fill="none"
            stroke={tone}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <Mountain className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="上下文用量明细"
          className="absolute bottom-full right-0 z-40 mb-3 w-72 rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-[0_18px_45px_rgba(0,0,0,0.14)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-neutral-900">上下文窗口</div>
              <div className="mt-0.5 text-[10px] text-neutral-400">实际 usage · {usage.model}</div>
            </div>
            <span className="font-mono text-lg font-semibold" style={{ color: tone }}>
              {percent}%
            </span>
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, backgroundColor: tone }} />
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-neutral-500">
            <div><dt>当前请求输入</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.input_tokens)}</dd></div>
            <div><dt>当前请求输出</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.output_tokens)}</dd></div>
            <div><dt>模型上下文窗口</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.context_limit_tokens)}</dd></div>
            <div><dt>剩余预算</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.remaining_tokens)}</dd></div>
            {/*<div className="col-span-2"><dt>压缩触发线</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.trigger_tokens)}</dd></div>*/}
          </dl>
          {/*<p className="mt-3 border-t border-neutral-100 pt-3 text-[10px] leading-relaxed text-neutral-500">
            仅展示接口返回的真实 token 数据与模型上下文窗口配置。更换模型后仅需配置模型上下文大小即可。
          </p>*/}
        </div>
      )}
    </div>
  );
};
