import React from 'react';
import { Loader2, AlertCircle, HardDrive, Wrench } from 'lucide-react';
import { useLmaStream, useContextUsage, useRuntimeStatus } from '../../agent/runtime';
import { Badge } from '../../components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';

export const RunStatusBar: React.FC = () => {
  const stream = useLmaStream();
  const contextUsage = useContextUsage();
  const runtimeStatus = useRuntimeStatus();

  const isRunning = Boolean(stream?.isLoading);
  const error = stream?.error;

  // 计算上下文使用率
  const usageRatio =
    contextUsage?.usage_ratio ??
    contextUsage?.window_usage_ratio ??
    (contextUsage?.max_tokens && contextUsage.used_tokens
      ? contextUsage.used_tokens / contextUsage.max_tokens
      : null);

  const percent =
    typeof usageRatio === 'number'
      ? Math.min(100, Math.max(0, Math.round(usageRatio * 100)))
      : null;

  return (
    <div className="w-full flex items-center justify-between text-xs px-2 py-1 text-neutral-500">
      <div className="flex items-center gap-2">
        {isRunning && (
          <div className="flex items-center gap-1.5 text-indigo-600 font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {runtimeStatus?.stage ||
                (runtimeStatus?.tool_name
                  ? `正在调用 ${runtimeStatus.tool_name}…`
                  : '正在分析监测数据…')}
            </span>
          </div>
        )}

        {runtimeStatus?.tool_count && runtimeStatus.tool_count > 0 && !isRunning && (
          <Badge variant="outline" className="text-[10px] gap-1 py-0 border-neutral-200 text-neutral-500">
            <Wrench className="w-2.5 h-2.5" />
            <span>调用工具 {runtimeStatus.tool_count} 次</span>
          </Badge>
        )}

        {Boolean(error) && (
          <div className="flex items-center gap-1.5 text-red-600">
            <AlertCircle className="w-3.5 h-3.5" />
            <span className="truncate max-w-sm">
              {typeof error === 'object' && error !== null && 'message' in error
                ? String((error as any).message)
                : '运行遇到错误'}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {percent !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-help px-2 py-0.5 rounded-full hover:bg-neutral-100 transition-colors">
                <HardDrive className="w-3 h-3 text-neutral-400" />
                <span
                  className={`font-mono text-[11px] ${
                    percent >= 80
                      ? 'text-red-600 font-semibold'
                      : percent >= 60
                      ? 'text-amber-600'
                      : 'text-neutral-500'
                  }`}
                >
                  {percent}%
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs space-y-1">
              <div className="font-semibold">上下文窗口预算</div>
              <div className="text-[11px] text-neutral-400">
                已使用 {percent}%
                {contextUsage?.used_tokens ? ` (${contextUsage.used_tokens} tokens)` : ''}
              </div>
              {percent >= 80 && (
                <div className="text-[10px] text-red-400">
                  提示：接近模型上下文上限，将自动触发历史压缩
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
