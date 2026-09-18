import React, { useMemo } from 'react';
import { AssistantRuntimeProvider, AuiConfig, Tools } from '@assistant-ui/react';
import { useStreamRuntime, useLangChainState, useLangChainStream } from '@assistant-ui/react-langchain';
import { LMA_ASSISTANT_ID } from '../app/config';
import { useLangGraphClient } from '../lib/langgraph';
import { lmaToolkit } from './toolkit';
import type { LmaState } from './state';

export interface LmaRuntimeProviderProps {
  threadId?: string | null;
  onThreadIdChange?: (newThreadId: string | undefined) => void;
  children: React.ReactNode;
}

export const LmaRuntimeProvider: React.FC<LmaRuntimeProviderProps> = ({
  threadId,
  onThreadIdChange,
  children,
}) => {
  const client = useLangGraphClient();

  const runtime = useStreamRuntime({
    assistantId: LMA_ASSISTANT_ID,
    client,
    threadId: threadId || null,
    messagesKey: 'messages',
    onThreadIdChange,
  });

  const config = useMemo(
    () =>
      AuiConfig({
        tools: Tools({ toolkit: lmaToolkit }),
      }),
    []
  );

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      {children}
    </AssistantRuntimeProvider>
  );
};

/**
 * 快捷读取 LangGraph State 自定义字段
 */
export function useLmaRecommendations(): string[] | undefined {
  return useLangChainState<string[]>('recommendations');
}

export function useContextUsage(): import('./state').ContextUsage | undefined {
  return useLangChainState<import('./state').ContextUsage>('context_usage');
}

export function useRuntimeStatus(): import('./state').RuntimeStatus | undefined {
  return useLangChainState<import('./state').RuntimeStatus>('runtime_status');
}

/**
 * 读取完整的自定义 state
 */
export function useLmaState(): LmaState | undefined {
  const stream = useLangChainStream();
  return stream?.values as LmaState | undefined;
}

/**
 * 读取底层流式状态
 */
export function useLmaStream() {
  return useLangChainStream();
}

