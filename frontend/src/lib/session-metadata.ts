import { useAuiState } from '@assistant-ui/react';
import type { ContextUsage } from '@/components/assistant-ui/elements/context-usage.aui';

interface SessionMetadata {
  context_usage?: ContextUsage;
}

/** 展示字段来自 checkpoint 的消息投影，不在前端维护第二份图状态。 */
export function useSessionMetadata(): SessionMetadata | undefined {
  return useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index--) {
      const message = state.thread.messages[index];
      if (message.role === 'assistant') {
        return message.metadata.custom.lma as SessionMetadata | undefined;
      }
    }
    return undefined;
  });
}
