import React from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { useMessageMetadata, type AnyStream } from '@langchain/react';
import type { BaseMessage } from '@langchain/core/messages';

export interface RunFailureCardProps {
  stream: AnyStream;
  lastHumanMessage?: BaseMessage;
  onRegenerate?: (checkpointId: string, message: BaseMessage) => void;
  onDismiss?: () => void;
}

/**
 * 主 Run 失败轻量卡片：
 * 通过官方 useMessageMetadata 响应式读取 parentCheckpointId，
 * 消除对私有 STREAM_CONTROLLER.messageMetadataStore 的访问，
 * 点击“重新生成”时遵循官方规范从该 checkpoint 分叉重试。
 * 没有有效 checkpoint 或用户消息时禁用“重新生成”，绝不伪造虚假消息。
 */
export const RunFailureCard: React.FC<RunFailureCardProps> = ({
  stream,
  lastHumanMessage,
  onRegenerate,
  onDismiss,
}) => {
  const metadata = useMessageMetadata(stream, lastHumanMessage?.id);
  if (metadata?.optimisticStatus === 'failed') {
    return null;
  }
  const parentCheckpointId = metadata?.parentCheckpointId;
  const canRegenerate = Boolean(parentCheckpointId && lastHumanMessage);

  return (
    <div className="max-w-4xl mx-auto w-full flex items-start gap-3.5" data-testid="run-failure-card">
      <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-sm">
        AI
      </div>
      <div className="flex-1 min-w-0 max-w-full items-start">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3.5 text-xs text-neutral-800 shadow-xs space-y-2.5">
          <div className="flex items-center gap-2 font-medium text-neutral-800">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>本次回答未能完成</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canRegenerate}
              onClick={() => {
                if (parentCheckpointId && lastHumanMessage) {
                  onRegenerate?.(parentCheckpointId, lastHumanMessage);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white border border-neutral-200 text-xs font-medium text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-xs transition-colors"
            >
              <RotateCcw className="w-3 h-3 text-neutral-500" />
              <span>重新生成</span>
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="px-2.5 py-1 rounded-lg text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
              >
                关闭
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
