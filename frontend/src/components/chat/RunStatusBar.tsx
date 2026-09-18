import React from 'react';
import { AlertTriangle, Archive } from 'lucide-react';
import type { AnyStream } from '@langchain/react';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { RunFailureCard } from '../RunFailureCard';
import { ThinkingIndicator } from '../ThinkingIndicator';
import { SummaryCard } from '../SummaryCard';
import type { ContextUsage } from '../ContextUsageIndicator';

interface RunStatusBarProps {
  stream?: AnyStream;
  hydrationError?: boolean;
  onReloadThread?: () => void;
  onDismissHydrationError?: () => void;
  runError?: boolean;
  runActive?: boolean;
  onRegenerate?: (checkpointId: string, message: BaseMessage) => void;
  onDismissRunError?: () => void;
  waitingForAssistant?: boolean;
  contextUsage?: ContextUsage;
  contextSummary?: string;
}

export const RunStatusBar: React.FC<RunStatusBarProps> = ({
  stream,
  hydrationError,
  onReloadThread,
  onDismissHydrationError,
  runError,
  runActive,
  onRegenerate,
  onDismissRunError,
  waitingForAssistant,
  contextUsage,
  contextSummary,
}) => {
  return (
    <>
      {/* 历史压缩摘要与分割线 */}
      {contextSummary && (
        <div className="max-w-4xl mx-auto w-full py-1">
          <div className="relative flex items-center justify-center my-3">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-dashed border-amber-300" />
            </div>
            <div className="relative flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-0.5 text-[11px] font-medium text-amber-800 shadow-xs">
              <Archive className="h-3 w-3 text-amber-600 shrink-0" />
              <span>历史对话已压缩至摘要 · 分割线之上为长期背景</span>
            </div>
          </div>
          <SummaryCard summary={contextSummary} />
        </div>
      )}

      {/* 会话加载失败状态卡 */}
      {hydrationError && (
        <div className="max-w-4xl mx-auto w-full my-3 p-3 rounded-xl border border-amber-200 bg-amber-50/70 text-xs text-neutral-800 flex items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>会话加载失败</span>
          </div>
          <div className="flex items-center gap-2">
            {onReloadThread && (
              <button
                type="button"
                onClick={onReloadThread}
                className="px-2.5 py-1 rounded-lg bg-white border border-neutral-200 text-xs font-medium text-neutral-700 hover:bg-neutral-50 transition-colors shadow-xs cursor-pointer"
              >
                重新加载
              </button>
            )}
            {onDismissHydrationError && (
              <button
                type="button"
                onClick={onDismissHydrationError}
                className="px-2 py-1 rounded-lg text-xs text-neutral-500 hover:text-neutral-800 transition-colors cursor-pointer"
              >
                关闭
              </button>
            )}
          </div>
        </div>
      )}

      {/* 主 Run 失败轻量卡 */}
      {runError && !runActive && stream && (
        <RunFailureCard
          stream={stream}
          lastHumanMessage={
            [...(stream.messages || [])]
              .reverse()
              .find((message) => HumanMessage.isInstance(message))
          }
          onRegenerate={(checkpointId, message) => onRegenerate?.(checkpointId, message)}
          onDismiss={() => onDismissRunError?.()}
        />
      )}

      {/* 尚未收到第一段权威消息时显示思考状态 */}
      {waitingForAssistant && (
        <div className="max-w-4xl mx-auto w-full flex items-start gap-3.5">
          <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-xs">
            AI
          </div>
          <div className="flex-1 min-w-0 text-neutral-800 text-sm py-0.5 space-y-2">
            <div className="py-1">
              <ThinkingIndicator
                statusText={
                  contextUsage?.usage_ratio && contextUsage.usage_ratio >= 0.8
                    ? '上下文接近触发线，正在执行历史压缩以释放窗口预算...'
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
};
