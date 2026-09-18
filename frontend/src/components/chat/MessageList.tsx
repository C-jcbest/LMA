import React from 'react';
import type { BaseMessage } from '@langchain/core/messages';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import { groupMessagesForDisplay } from '../messageDisplay';
import { UserMessage } from './UserMessage';
import { AssistantTurn } from './AssistantTurn';

interface MessageListProps {
  messages: BaseMessage[];
  runActive: boolean;
  toolCalls?: AssembledToolCall[];
  renderOptimisticStatus?: (messageId?: string) => React.ReactNode;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  runActive,
  toolCalls = [],
  renderOptimisticStatus,
}) => {
  const displayTurns = groupMessagesForDisplay(messages);
  const liveToolCalls = new Map(toolCalls.map((toolCall) => [toolCall.callId, toolCall]));

  return (
    <>
      {displayTurns.map((turn, index) => {
        const isUser = turn.kind === 'human';
        const isLast = index === displayTurns.length - 1;
        const isStreamingAssistant = runActive && isLast && !isUser;

        if (isUser) {
          return (
            <UserMessage
              key={turn.message.id || index}
              message={turn.message}
              renderOptimisticStatus={renderOptimisticStatus}
            />
          );
        }

        const turnKey = turn.messages[0]?.id || index;
        return (
          <AssistantTurn
            key={turnKey}
            messages={turn.messages}
            isStreamingAssistant={isStreamingAssistant}
            liveToolCalls={liveToolCalls}
          />
        );
      })}
    </>
  );
};
