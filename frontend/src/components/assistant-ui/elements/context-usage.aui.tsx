"use client";

import * as Popover from "@radix-ui/react-popover";
import { Mountain } from "lucide-react";
import type { FC } from "react";

export interface ContextUsage {
  input_tokens?: number;
  output_tokens?: number;
  context_limit_tokens?: number;
  remaining_tokens?: number | null;
  usage_ratio?: number | null;
  counter?: "provider_reported";
  model?: string;
}

const formatTokens = (value?: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString("zh-CN");
};

export const ContextUsageElement: FC<{ usage?: ContextUsage }> = ({ usage }) => {
  const isComplete =
    usage?.counter === "provider_reported" &&
    typeof usage.input_tokens === "number" &&
    typeof usage.context_limit_tokens === "number" &&
    usage.context_limit_tokens > 0 &&
    typeof usage.usage_ratio === "number";
  if (!isComplete) return null;

  const ratio = Math.max(0, Math.min(1, usage.usage_ratio as number));
  const percent = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 12;
  const tone = ratio >= 0.8 ? "#dc2626" : ratio >= 0.6 ? "#d97706" : "#6366f1";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none"
          title={`上下文预算已用 ${percent}%`}
          aria-label={`上下文预算已用 ${percent}%`}
        >
          <svg className="absolute inset-0 h-8 w-8 -rotate-90" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="12" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
            <circle cx="16" cy="16" r="12" fill="none" stroke={tone} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
          </svg>
          <Mountain className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={12} className="z-40 w-72 rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-[0_18px_45px_rgba(0,0,0,0.14)] focus:outline-none">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-neutral-900">上下文窗口</div>
              <div className="mt-0.5 text-[10px] text-neutral-400">实际 usage · {usage.model || "标准模型"}</div>
            </div>
            <span className="font-mono text-lg font-semibold" style={{ color: tone }}>{percent}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, backgroundColor: tone }} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-neutral-500">
            <div><dt>当前请求输入</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.input_tokens)}</dd></div>
            <div><dt>当前请求输出</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.output_tokens)}</dd></div>
            <div><dt>模型上下文窗口</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.context_limit_tokens)}</dd></div>
            <div><dt>剩余预算</dt><dd className="mt-0.5 font-mono font-medium text-neutral-800">{formatTokens(usage.remaining_tokens)}</dd></div>
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
