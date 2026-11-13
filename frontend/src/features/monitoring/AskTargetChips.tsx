import type { FC } from 'react';
import { useAui, useAuiEvent, useAuiState } from '@assistant-ui/react';
import { ChartLineIcon, XIcon } from 'lucide-react';
import { askTargetLabel, askTargetsOfMessage, askTargetsOfRunConfig, clearAskTargets, removeAskTarget } from './ask-targets';

const CHIP_CLASS = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-foreground tabular-nums';

/** 输入框上方的追问对象，可逐个移除；发送后清空，只属于这一条消息。 */
export const ComposerAskTargets: FC = () => {
  const aui = useAui();
  const runConfig = useAuiState((state) => state.composer.runConfig);
  const targets = askTargetsOfRunConfig(runConfig);
  useAuiEvent('composer.send', (event) => {
    // 编辑历史消息也会触发发送事件，此时不动当前输入框的追问对象。
    if (event.messageId === undefined) {
      clearAskTargets(aui);
    }
  });
  if (targets.length === 0) {
    return null;
  }
  return (
    <ul aria-label="追问对象" className="flex w-full flex-wrap gap-1.5">
      {targets.map((target) => {
        const label = askTargetLabel(target);
        return (
          <li key={label} className={`${CHIP_CLASS} pe-0.5`}>
            <ChartLineIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{label}</span>
            <button
              type="button"
              aria-label={`移除追问对象 ${label}`}
              onClick={() => removeAskTarget(aui, target)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
};

/** 用户消息上显示这条消息追问的测点时间段，来自服务端保存的消息 metadata。 */
export const MessageAskTargets: FC = () => {
  const custom = useAuiState((state) => state.message.metadata.custom);
  const targets = askTargetsOfMessage(custom);
  if (targets.length === 0) {
    return null;
  }
  return (
    <ul aria-label="追问对象" className="flex flex-wrap justify-end gap-1.5">
      {targets.map((target) => {
        const label = askTargetLabel(target);
        return (
          <li key={label} className={CHIP_CLASS}>
            <ChartLineIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{label}</span>
          </li>
        );
      })}
    </ul>
  );
};
