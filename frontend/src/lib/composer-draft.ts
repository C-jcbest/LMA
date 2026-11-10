import type { useAui } from '@assistant-ui/react';

/** 把一句话追加到输入框，保留用户已经写下的草稿；是否发送由用户决定。 */
export function appendToComposerDraft(aui: ReturnType<typeof useAui>, text: string) {
  const draft = aui.composer().getState().text;
  aui.composer().setText(draft.trim() ? `${draft}\n${text}` : text);
}
