import React from 'react';
import { useMessageMetadata, type AnyStream } from '@langchain/react';

interface OptimisticMessageStatusProps {
  stream: AnyStream;
  messageId?: string;
}

/** 只消费官方 optimisticStatus；重试交互由 TODO 14 统一实现。 */
export const OptimisticMessageStatus: React.FC<OptimisticMessageStatusProps> = ({ stream, messageId }) => {
  const status = useMessageMetadata(stream, messageId)?.optimisticStatus;
  if (status === 'pending') return <span className="text-[11px] text-neutral-400" role="status">发送中…</span>;
  if (status === 'failed') return <span className="text-[11px] text-red-600" role="alert">发送失败</span>;
  return null;
};
