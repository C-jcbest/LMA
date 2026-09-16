import React from 'react';
import { useMessageMetadata, type AnyStream } from '@langchain/react';

interface OptimisticMessageStatusProps {
  stream: AnyStream;
  messageId?: string;
  onRetry?: () => void;
}

/** 只消费官方 optimisticStatus；发送失败直接在该消息旁提供重试交互。 */
export const OptimisticMessageStatus: React.FC<OptimisticMessageStatusProps> = ({ stream, messageId, onRetry }) => {
  const status = useMessageMetadata(stream, messageId)?.optimisticStatus;
  if (status === 'pending') {
    return <span className="text-[11px] text-neutral-400" role="status">发送中…</span>;
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-600" role="alert">
        <span>发送失败</span>
        {onRetry && (
          <>
            <span className="text-neutral-300 select-none">·</span>
            <button
              type="button"
              onClick={onRetry}
              className="underline hover:text-red-700 transition-colors cursor-pointer"
            >
              重试
            </button>
          </>
        )}
      </span>
    );
  }
  return null;
};
