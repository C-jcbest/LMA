import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import { useStreamRuntime } from '@assistant-ui/react-langchain';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { LMA_ASSISTANT_ID } from '@/services/api';
import { createLangGraphThreadListAdapter } from '@/lib/langgraph/thread-list-adapter';

import { LiveToolEventsProvider } from '@/lib/langgraph/live-tool-results';

export interface AssistantProviderProps {
  client: Client;
  children: React.ReactNode;
}

/**
 * 唯一 Runtime Provider：
 * 负责 LangGraph 客户端装配与 useStreamRuntime 初始化，
 * 通过薄 URL 适配层与 browser searchParams (?threadId=...) 保持原生同步，
 * 支持页面刷新、历史后退与直接复制 URL，完全委托 assistant-ui controlled runtime 自动切换，
 * 不维护额外的会话切换或消息状态机。
 */
export const AssistantProvider: React.FC<AssistantProviderProps> = ({
  client,
  children,
}) => {
  const [urlThreadId, setUrlThreadId] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return new URL(window.location.href).searchParams.get('threadId') || undefined;
  });

  const handleThreadIdChange = useCallback((newId: string | undefined) => {
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
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId') || undefined;
      setUrlThreadId(id);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
    threadId: urlThreadId,
    onThreadIdChange: handleThreadIdChange,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <LiveToolEventsProvider>
        {children}
      </LiveToolEventsProvider>
    </AssistantRuntimeProvider>
  );
};
