import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger, PopoverHeader, PopoverTitle } from "@/components/ui/popover";
import { CircularProgress } from "@/components/ui/circular-progress";
import { Button } from "@/components/ui/button";
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
  counter?: 'provider_reported';
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

export const ContextUsageElement: React.FC<ContextUsageElementProps> = ({
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

  const isCritical = ratio >= 0.8;
  const isWarning = ratio >= 0.6;

  const tone = isCritical
    ? {
        indicator: "stroke-rose-500",
        badge: "text-rose-600 bg-rose-50 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/50",
        label: "即将超限",
      }
    : isWarning
      ? {
          indicator: "stroke-amber-500",
          badge: "text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900/50",
          label: "用量较高",
        }
      : {
          indicator: "stroke-emerald-500",
          badge: "text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900/50",
          label: "容量充裕",
        };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 rounded-full border border-neutral-200/80 bg-background/80 px-2 text-xs font-normal text-muted-foreground shadow-2xs backdrop-blur-xs transition-colors hover:bg-muted/80 hover:text-foreground dark:border-neutral-800/80",
            className
          )}
          title={`上下文预算已用 ${percent}%`}
          aria-label={`上下文预算已用 ${percent}%`}
        >
          <CircularProgress
            value={percent}
            size={15}
            strokeWidth={2.4}
            indicatorClassName={tone.indicator}
          />
          <span className="tabular-nums font-mono text-[11px] font-medium leading-none text-foreground/80">
            {percent}%
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-68 rounded-2xl border border-neutral-200/90 bg-background/95 p-4 shadow-xl backdrop-blur-md dark:border-neutral-800"
      >
        <PopoverHeader className="flex flex-row items-center gap-3 space-y-0 pb-1">
          <CircularProgress
            value={percent}
            size={42}
            strokeWidth={3.8}
            indicatorClassName={tone.indicator}
          >
            <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">
              {percent}%
            </span>
          </CircularProgress>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-1.5">
              <PopoverTitle className="text-xs font-medium text-foreground">
                上下文窗口
              </PopoverTitle>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none",
                  tone.badge
                )}
              >
                {tone.label}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {usage.model || "标准模型"}
            </p>
          </div>
        </PopoverHeader>

        <div className="mt-3.5 grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-2.5 text-xs">
          <div>
            <span className="text-[10px] text-muted-foreground">当前请求输入</span>
            <div className="mt-0.5 font-mono text-[11px] font-medium text-foreground">
              {formatTokens(usage.input_tokens)}
            </div>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">模型上下文窗口</span>
            <div className="mt-0.5 font-mono text-[11px] font-medium text-foreground">
              {formatTokens(usage.context_limit_tokens)}
            </div>
          </div>
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground/80">
          💡 上下文超限时系统将自动压缩历史轮次，确保推理连续。
        </p>
      </PopoverContent>
    </Popover>
  );
};
