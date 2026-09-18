import React, { useMemo } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useStreamRuntime, useLangChainState, useLangChainStream } from '@assistant-ui/react-langchain';
import { LMA_ASSISTANT_ID, getApiUrl } from '../app/config';
import { createLangGraphClient } from '../lib/langgraph';
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
  const apiUrl = useMemo(() => getApiUrl(), []);
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);

  const runtime = useStreamRuntime({
    assistantId: LMA_ASSISTANT_ID,
    client,
    threadId: threadId || null,
    messagesKey: 'messages',
    onThreadIdChange,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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

