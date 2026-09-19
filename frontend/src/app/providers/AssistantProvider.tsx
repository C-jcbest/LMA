import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import { useStreamRuntime } from '@assistant-ui/react-langchain';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { LMA_ASSISTANT_ID } from '@/services/api';
import { createLangGraphThreadListAdapter } from '@/lib/langgraph/thread-list-adapter';

export interface AssistantProviderProps {
  client: Client;
  children: React.ReactNode;
  /** 可选受控 threadId（外部覆盖或测试注入） */
  threadId?: string | undefined;
  /** 可选受控变更回调 */
  onThreadIdChange?: (threadId: string | undefined) => void;
}

/**
 * 唯一 Runtime Provider：
 * 负责 LangGraph 客户端装配与 useStreamRuntime 初始化，
 * 通过薄 URL 适配层与 browser searchParams (?threadId=...) 保持原生同步，
 * 支持页面刷新、历史后退与直接复制 URL，不维护额外的会话切换或消息状态机。
 */
export const AssistantProvider: React.FC<AssistantProviderProps> = ({
  client,
  children,
  threadId: controlledThreadId,
  onThreadIdChange: controlledOnThreadIdChange,
}) => {
  const isControlled = controlledThreadId !== undefined;

  const [urlThreadId, setUrlThreadId] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return new URL(window.location.href).searchParams.get('threadId') || undefined;
  });

  const handleThreadIdChange = useCallback(
    (newId: string | undefined) => {
      if (controlledOnThreadIdChange) {
        controlledOnThreadIdChange(newId);
      }
      if (!isControlled) {
        setUrlThreadId(newId);
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          const currentParam = url.searchParams.get('threadId') || undefined;
          const targetParam = newId || undefined;
          if (currentParam !== targetParam) {
            if (targetParam) {
              url.searchParams.set('threadId', targetParam);
            } else {
              url.searchParams.delete('threadId');
            }
            window.history.pushState(null, '', url);
          }
        }
      }
    },
    [controlledOnThreadIdChange, isControlled]
  );

  useEffect(() => {
    if (isControlled || typeof window === 'undefined') return;

    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId') || undefined;
      setUrlThreadId(id);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isControlled]);

  const effectiveThreadId = isControlled ? controlledThreadId : urlThreadId;

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
    threadId: effectiveThreadId,
    onThreadIdChange: handleThreadIdChange,
  });

  // 同步外部/URL threadId 到 assistant-ui runtime 会话切换
  useEffect(() => {
    if (!runtime.threads) return;
    const state = runtime.threads.getState();
    const currentActive = state.mainThreadId;
    if (effectiveThreadId) {
      if (currentActive !== effectiveThreadId) {
        runtime.threads.switchToThread(effectiveThreadId);
      }
    } else if (state.newThreadId && currentActive !== state.newThreadId) {
      runtime.threads.switchToNewThread();
    }
  }, [effectiveThreadId, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};
