import React from 'react';
import {
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import { MarkdownMessage } from '../MarkdownMessage';
import { InlineToolCall } from '../InlineToolCall';
import { ThinkingBlock } from '../ThinkingBlock';
import { MessageActions } from '../MessageActions';
import { ErrorBoundary } from '../ErrorBoundary';

interface AssistantTurnProps {
  messages: Array<AIMessage | ToolMessage>;
  isStreamingAssistant?: boolean;
  liveToolCalls: Map<string, AssembledToolCall>;
}

const getCreatedAt = (message: AIMessage): string | undefined => {
  const value = message.additional_kwargs?.created_at;
  return typeof value === 'string' ? value : undefined;
};

const getAssistantText = (messages: Array<AIMessage | ToolMessage>): string =>
  messages
    .filter((message): message is AIMessage => AIMessage.isInstance(message))
    .flatMap((message) => message.contentBlocks)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

export const AssistantTurn: React.FC<AssistantTurnProps> = ({
  messages,
  isStreamingAssistant = false,
  liveToolCalls,
}) => {
  const toolMessages = new Map(
    messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map((message) => [message.tool_call_id, message])
  );
  const aiMessages = messages.filter(
    (message): message is AIMessage => AIMessage.isInstance(message)
  );
  const lastAIMessage = aiMessages[aiMessages.length - 1];
  const fullText = getAssistantText(messages);

  return (
    <div className="group max-w-4xl mx-auto w-full">
      <div className="flex items-start gap-3.5 flex-row">
        <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-xs">
          AI
        </div>

        <div className="min-w-0 flex flex-col flex-1 max-w-full items-start">
          <div className="w-full text-neutral-800 text-sm py-0.5 space-y-2">
            {aiMessages.map((aiMessage) => {
              const blocks = aiMessage.contentBlocks;
              return (
                <React.Fragment key={aiMessage.id || messages.indexOf(aiMessage)}>
                  {blocks.map((block, blockIndex) => {
                    if (block.type === 'text') {
                      return block.text ? (
                        <MarkdownMessage key={blockIndex} content={block.text} />
                      ) : null;
                    }
                    if (block.type === 'reasoning') {
                      return block.reasoning ? (
                        <ThinkingBlock
                          key={blockIndex}
                          content={block.reasoning}
                          isActive={
                            isStreamingAssistant &&
                            aiMessage === lastAIMessage &&
                            blockIndex === blocks.length - 1
                          }
                        />
                      ) : null;
                    }
                    if (block.type === 'tool_call') {
                      return (
                        <ErrorBoundary key={block.id || blockIndex} fallbackTitle="工具结果渲染异常">
                          <InlineToolCall
                            toolCall={block}
                            liveToolCall={block.id ? liveToolCalls.get(block.id) : undefined}
                            toolMessage={block.id ? toolMessages.get(block.id) : undefined}
                          />
                        </ErrorBoundary>
                      );
                    }
                    return null;
                  })}
                </React.Fragment>
              );
            })}
          </div>

          <MessageActions
            align="left"
            getText={() => fullText}
            timestamp={lastAIMessage ? getCreatedAt(lastAIMessage) : undefined}
          />
        </div>
      </div>
    </div>
  );
};
