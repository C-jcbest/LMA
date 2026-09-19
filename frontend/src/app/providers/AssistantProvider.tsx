import React, { useMemo } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import { useStreamRuntime } from '@assistant-ui/react-langchain';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { LMA_ASSISTANT_ID } from '@/services/api';
import { createLangGraphThreadListAdapter } from '@/lib/langgraph/thread-list-adapter';

export interface AssistantProviderProps {
  client: Client;
  children: React.ReactNode;
}

/**
 * 唯一 Runtime Provider：
 * 负责 LangGraph 客户端装配与 useStreamRuntime 初始化，
 * 不维护本地 messages、running、tool-call、fork 或重试状态。
 */
export const AssistantProvider: React.FC<AssistantProviderProps> = ({ client, children }) => {
  const threadListAdapter = useMemo(
    () => createLangGraphThreadListAdapter(client, LMA_ASSISTANT_ID),
    [client]
  );

  const runtime = useStreamRuntime({
    assistantId: LMA_ASSISTANT_ID,
    client,
    messagesKey: 'messages',
    unstable_allowCancellation: true,
    unstable_threadListAdapter: threadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};
