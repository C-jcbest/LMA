import React from 'react';
import type { AnyStream } from '@langchain/react';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import type { BaseMessage } from '@langchain/core/messages';
import { groupMessagesForDisplay } from './messageDisplay';
import { ContextUsage } from './ContextUsageIndicator';
import { ChatHeader } from './chat/ChatHeader';
import { ThreadViewport } from './chat/ThreadViewport';
import { MessageList } from './chat/MessageList';
import { RunStatusBar } from './chat/RunStatusBar';
import { NextActions } from './chat/NextActions';
import { Composer } from './chat/Composer';

export interface ChatWindowProps {
  stream?: AnyStream;
  messages: BaseMessage[];
  toolCalls?: AssembledToolCall[];
  contextSummary?: string;
  contextUsage?: ContextUsage;
  onSendMessage: (text: string) => void;
  threadLoading: boolean;
  runActive: boolean;
  renderOptimisticStatus?: (messageId?: string) => React.ReactNode;
  recommendations?: string[];
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isNewSessionDraft?: boolean;
  onStopGeneration?: () => void;

  // 分层错误 props
  runError?: boolean;
  onRegenerate?: (checkpointId: string, message: BaseMessage) => void;
  onDismissRunError?: () => void;
  hydrationError?: boolean;
  onReloadThread?: () => void;
  onDismissHydrationError?: () => void;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  stream,
  messages,
  toolCalls = [],
  contextSummary,
  contextUsage,
  onSendMessage,
  threadLoading,
  runActive,
  renderOptimisticStatus,
  recommendations = [],
  isSidebarCollapsed,
  onToggleSidebar,
  onStopGeneration,
  runError = false,
  onRegenerate,
  onDismissRunError,
  hydrationError = false,
  onReloadThread,
  onDismissHydrationError,
}) => {
  const displayTurns = groupMessagesForDisplay(messages);
  const lastTurn = displayTurns[displayTurns.length - 1];
  const waitingForAssistant = runActive && (!lastTurn || lastTurn.kind === 'human');

  return (
    <div className="flex-1 h-full flex flex-col bg-white text-neutral-800 relative overflow-hidden">
      {/* 顶部 Header */}
      <ChatHeader
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
      />

      {/* 消息视口 */}
      <ThreadViewport
        dependencies={[
          messages,
          threadLoading,
          runActive,
          recommendations,
          runError,
          hydrationError,
        ]}
      >
        {/* 状态与压缩历史 */}
        <RunStatusBar
          stream={stream}
          contextSummary={contextSummary}
          hydrationError={hydrationError}
          onReloadThread={onReloadThread}
          onDismissHydrationError={onDismissHydrationError}
          runError={runError}
          runActive={runActive}
          onRegenerate={onRegenerate}
          onDismissRunError={onDismissRunError}
          waitingForAssistant={waitingForAssistant}
          contextUsage={contextUsage}
        />

        {/* 消息列表 */}
        <MessageList
          messages={messages}
          runActive={runActive}
          toolCalls={toolCalls}
          renderOptimisticStatus={renderOptimisticStatus}
        />

        {/* 下一步建议 */}
        {!threadLoading && !runActive && (
          <NextActions
            recommendations={recommendations}
            onSelectAction={onSendMessage}
          />
        )}

        {threadLoading && (
          <div
            className="mx-auto w-full max-w-4xl text-center text-xs text-neutral-400 py-2"
            role="status"
          >
            正在加载会话…
          </div>
        )}
      </ThreadViewport>

      {/* 底部输入区 */}
      <Composer
        onSendMessage={onSendMessage}
        onStopGeneration={onStopGeneration}
        runActive={runActive}
        threadLoading={threadLoading}
        contextUsage={contextUsage}
      />
    </div>
  );
};
