import React from 'react';
import type { HumanMessage } from '@langchain/core/messages';
import { MarkdownMessage } from '../MarkdownMessage';
import { MessageActions } from '../MessageActions';

interface UserMessageProps {
  message: HumanMessage;
  renderOptimisticStatus?: (messageId?: string) => React.ReactNode;
}

const getCreatedAt = (message: HumanMessage): string | undefined => {
  const value = message.additional_kwargs?.created_at;
  return typeof value === 'string' ? value : undefined;
};

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  renderOptimisticStatus,
}) => {
  const messageText = typeof message.content === 'string' ? message.content : message.text || '';

  return (
    <div className="group max-w-4xl mx-auto w-full">
      <div className="flex items-start gap-3.5 flex-row-reverse">
        <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200/80 flex items-center justify-center shrink-0 text-xs font-semibold text-neutral-700 select-none">
          ME
        </div>

        <div className="min-w-0 flex flex-col max-w-[75%] items-end">
          <div className="bg-[#f3f4f6] text-neutral-800 text-sm px-4 py-2.5 rounded-2xl rounded-tr-sm shadow-xs">
            <MarkdownMessage content={messageText} />
          </div>

          <MessageActions
            align="right"
            getText={() => messageText}
            timestamp={getCreatedAt(message)}
          />
          {renderOptimisticStatus?.(message.id)}
        </div>
      </div>
    </div>
  );
};
