import React from 'react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';

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
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString('zh-CN');
};

export const ContextUsageElement: React.FC<ContextUsageElementProps> = ({
  usage,
  className,
}) => {
  const isComplete =
    usage?.counter === 'provider_reported' &&
    typeof usage.input_tokens === 'number' &&
    typeof usage.context_limit_tokens === 'number' &&
    usage.context_limit_tokens > 0 &&
    typeof usage.usage_ratio === 'number';

  if (!isComplete) return null;

  const ratio = Math.max(0, Math.min(1, usage.usage_ratio as number));
  const percent = Math.round(ratio * 100);

  const indicatorColorClass =
    ratio >= 0.8
      ? 'bg-rose-500'
      : ratio >= 0.6
        ? 'bg-amber-500'
        : 'bg-primary';

  const toneTextColor =
    ratio >= 0.8
      ? 'text-rose-600 dark:text-rose-400'
      : ratio >= 0.6
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-primary';

  return (
    <TooltipProvider delayDuration={300}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 gap-1.5 px-2 text-xs font-normal text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
              className
            )}
            title={`上下文预算已用 ${percent}%`}
            aria-label={`上下文预算已用 ${percent}%`}
          >
            <div className="w-8">
              <Progress
                value={percent}
                className="h-1.5 w-full bg-slate-200 dark:bg-slate-700"
                indicatorClassName={indicatorColorClass}
              />
            </div>
            <span className="tabular-nums font-mono text-[11px]">{percent}%</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="w-72 p-4 text-xs shadow-xl"
        >
          <PopoverHeader className="flex flex-row items-start justify-between gap-3 pb-1">
            <div>
              <PopoverTitle className="font-semibold text-neutral-900 dark:text-neutral-100">
                上下文窗口
              </PopoverTitle>
              <PopoverDescription className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                实际 usage · {usage.model || '标准模型'}
              </PopoverDescription>
            </div>
            <span className={cn('font-mono text-lg font-semibold tabular-nums', toneTextColor)}>
              {percent}%
            </span>
          </PopoverHeader>

          <div className="mt-3">
            <Progress
              value={percent}
              className="h-1.5 w-full bg-neutral-100 dark:bg-neutral-800"
              indicatorClassName={indicatorColorClass}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-neutral-500 dark:text-neutral-400">
            <div>
              <div className="text-[11px]">当前请求输入</div>
              <div className="mt-0.5 font-mono font-medium text-neutral-800 dark:text-neutral-200">
                {formatTokens(usage.input_tokens)}
              </div>
            </div>
            <div>
              <div className="text-[11px]">当前请求输出</div>
              <div className="mt-0.5 font-mono font-medium text-neutral-800 dark:text-neutral-200">
                {formatTokens(usage.output_tokens)}
              </div>
            </div>
            <div>
              <div className="text-[11px]">模型上下文窗口</div>
              <div className="mt-0.5 font-mono font-medium text-neutral-800 dark:text-neutral-200">
                {formatTokens(usage.context_limit_tokens)}
              </div>
            </div>
            <div>
              <div className="text-[11px]">剩余预算</div>
              <div className="mt-0.5 font-mono font-medium text-neutral-800 dark:text-neutral-200">
                {formatTokens(usage.remaining_tokens)}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
