import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';

export type DisplayTurn =
  | { kind: 'human'; message: HumanMessage }
  | { kind: 'assistant'; messages: Array<AIMessage | ToolMessage> };

/**
 * 仅按用户回合组织官方消息实例；不复制内容，也不派生运行或工具状态。
 */
export function groupMessagesForDisplay(messages: BaseMessage[]): DisplayTurn[] {
  const turns: DisplayTurn[] = [];
  let assistantTurn: Extract<DisplayTurn, { kind: 'assistant' }> | undefined;

  for (const message of messages) {
    if (HumanMessage.isInstance(message)) {
      assistantTurn = undefined;
      if (message.additional_kwargs.lc_source === 'summarization') continue;
      turns.push({ kind: 'human', message });
      continue;
    }

    if (!AIMessage.isInstance(message) && !ToolMessage.isInstance(message)) continue;
    if (!assistantTurn) {
      assistantTurn = { kind: 'assistant', messages: [] };
      turns.push(assistantTurn);
    }
    assistantTurn.messages.push(message);
  }

  return turns;
}
