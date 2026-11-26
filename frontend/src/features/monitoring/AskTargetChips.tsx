import type { FC } from 'react';
import { useAui, useAuiEvent, useAuiState } from '@assistant-ui/react';
import { ChartLineIcon, CloudRainIcon, XIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from 'cn';
import { EASE_IN, SPRING_SNAPPY } from '@/components/ui/motion-primitives';
import { askTargetLabel, askTargetsOfMessage, askTargetsOfRunConfig, clearAskTargets, removeAskTarget, type AskKind } from './ask-targets';

const CHIP_CLASS = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-foreground tabular-nums';

const TargetIcon: FC<{ kind?: AskKind }> = ({ kind }) =>
  kind === 'rainfall'
    ? <CloudRainIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    : <ChartLineIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;

export const ComposerAskTargets: FC = () => {
  const aui = useAui();
  const runConfig = useAuiState((state) => state.composer.runConfig);
  const targets = askTargetsOfRunConfig(runConfig);
  useAuiEvent('composer.send', (event) => {
    if (event.messageId === undefined) {
      clearAskTargets(aui);
    }
  });
  if (targets.length === 0) {
    return null;
  }
  return (
    <ul aria-label="追问对象" className="flex w-full flex-wrap gap-1.5">
      <AnimatePresence initial={false}>
        {targets.map((target) => {
          const label = askTargetLabel(target);
          return (
            <motion.li
              key={label}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1, transition: SPRING_SNAPPY }}
              exit={{ opacity: 0, scale: 0.9, transition: EASE_IN }}
              className={cn(CHIP_CLASS, 'pe-0.5')}
            >
              <TargetIcon kind={target.kind} />
              <span className="min-w-0 truncate">{label}</span>
              <button
                type="button"
                aria-label={`移除追问对象 ${label}`}
                onClick={() => removeAskTarget(aui, target)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-background hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
};

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
            <TargetIcon kind={target.kind} />
            <span className="min-w-0 truncate">{label}</span>
          </li>
        );
      })}
    </ul>
  );
};
