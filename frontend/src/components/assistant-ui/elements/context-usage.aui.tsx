import React, { FC } from "react";
import { CircularProgress } from "@/components/ui/circular-progress";
import { cn } from "@/lib/utils";

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
  counter?: "provider_reported";
  model?: string;
}

export interface ContextUsageElementProps {
  usage?: ContextUsage;
  className?: string;
}

const formatTokens = (value?: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString("zh-CN");
};

export const ContextUsageElement: FC<ContextUsageElementProps> = ({
  usage,
  className,
}) => {
  const isComplete =
    usage?.counter === "provider_reported" &&
    typeof usage.input_tokens === "number" &&
    typeof usage.context_limit_tokens === "number" &&
    usage.context_limit_tokens > 0 &&
    typeof usage.usage_ratio === "number";

  if (!isComplete) return null;

  const ratio = Math.max(0, Math.min(1, usage.usage_ratio as number));
  const percent = Math.round(ratio * 100);

  const indicatorColorClass =
    ratio >= 0.8
      ? "stroke-rose-500"
      : ratio >= 0.6
        ? "stroke-amber-500"
        : "stroke-emerald-500";

  const dotColorClass =
    ratio >= 0.8
      ? "bg-rose-500"
      : ratio >= 0.6
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="group relative inline-flex items-center justify-center">
      <button
        type="button"
        className={cn(
          "inline-flex size-5 items-center justify-center p-0 m-0 border-0 bg-transparent cursor-pointer rounded-full outline-hidden transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring",
          className
        )}
        aria-label={`上下文预算已用 ${percent}%`}
      >
        <CircularProgress
          value={percent}
          size={18}
          strokeWidth={2.2}
          indicatorClassName={indicatorColorClass}
          trackClassName="stroke-neutral-200/80 dark:stroke-neutral-800"
        />
      </button>

      {/* 定制悬浮提示窗（非浏览器原生样式，悬停与聚焦时平滑显示） */}
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 z-50 w-max rounded-lg border border-neutral-200/80 bg-white/95 px-3 py-2 text-xs text-neutral-800 shadow-md backdrop-blur-xs transition-all duration-200 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 dark:border-neutral-800/80 dark:bg-neutral-900/95 dark:text-neutral-200"
      >
        <div className="flex flex-col gap-1 text-left">
          <div className="flex items-center gap-1.5 font-medium whitespace-nowrap">
            <span className={cn("size-1.5 rounded-full", dotColorClass)} />
            <span>上下文已用 {percent}%</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-neutral-500 whitespace-nowrap dark:text-neutral-400">
            <span>当前请求输入</span>
            <span className="font-mono font-medium text-neutral-700 dark:text-neutral-300">
              {formatTokens(usage.input_tokens)}
            </span>
            <span>/</span>
            <span>上限</span>
            <span className="font-mono font-medium text-neutral-700 dark:text-neutral-300">
              {formatTokens(usage.context_limit_tokens)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// 兼容旧命名的薄别名导出（允许 import { ContextUsageIndicator } from "@/components/assistant-ui/elements/context-usage.aui"）
export { ContextUsageElement as ContextUsageIndicator };
export type { ContextUsageElementProps as ContextUsageIndicatorProps };
