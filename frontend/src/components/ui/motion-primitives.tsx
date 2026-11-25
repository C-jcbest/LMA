import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RotateCcwIcon, XIcon } from 'lucide-react';
import { Button } from './button';

export const SPRING_SNAPPY = { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 } as const;
export const SPRING_PANEL = { type: 'spring', stiffness: 360, damping: 34, mass: 0.9 } as const;
export const EASE_OUT = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;
export const EASE_IN = { duration: 0.16, ease: [0.4, 0, 1, 1] } as const;

interface PendingDelete {
  id: string;
  label: string;
  commit: () => Promise<void>;
  timerId: number;
}

interface SessionUndoContextValue {
  pendingIds: ReadonlySet<string>;
  scheduleDelete: (id: string, label: string, commit: () => Promise<void>) => void;
  undoDelete: (id: string) => void;
}

const UNDO_DELAY_MS = 5000;

const NOOP_UNDO: SessionUndoContextValue = {
  pendingIds: new Set(),
  scheduleDelete: (_id, _label, commit) => {
    void commit();
  },
  undoDelete: () => {},
};

const SessionUndoContext = createContext<SessionUndoContextValue>(NOOP_UNDO);

export function SessionUndoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingDelete[]>([]);
  const pendingRef = useRef<PendingDelete[]>([]);
  pendingRef.current = pending;

  const commitItem = useCallback((id: string) => {
    const item = pendingRef.current.find((entry) => entry.id === id);
    if (!item) return;
    window.clearTimeout(item.timerId);
    setPending((current) => current.filter((entry) => entry.id !== id));
    void item.commit().catch(() => {});
  }, []);

  const undoDelete = useCallback((id: string) => {
    const item = pendingRef.current.find((entry) => entry.id === id);
    if (!item) return;
    window.clearTimeout(item.timerId);
    setPending((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const scheduleDelete = useCallback((id: string, label: string, commit: () => Promise<void>) => {
    if (pendingRef.current.some((entry) => entry.id === id)) return;
    const timerId = window.setTimeout(() => commitItem(id), UNDO_DELAY_MS);
    setPending((current) => [...current, { id, label, commit, timerId }]);
  }, [commitItem]);

  useEffect(() => {
    const flushAll = () => {
      for (const item of pendingRef.current) {
        window.clearTimeout(item.timerId);
        void item.commit().catch(() => {});
      }
      pendingRef.current = [];
    };
    window.addEventListener('pagehide', flushAll);
    return () => {
      window.removeEventListener('pagehide', flushAll);
      flushAll();
    };
  }, []);

  const pendingIds = useMemo(() => new Set(pending.map((item) => item.id)), [pending]);
  const value = useMemo(
    () => ({ pendingIds, scheduleDelete, undoDelete }),
    [pendingIds, scheduleDelete, undoDelete],
  );
  const latest = pending.at(-1);

  return (
    <SessionUndoContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
        <AnimatePresence>
          {latest && (
            <motion.div
              key={latest.id}
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={SPRING_SNAPPY}
              className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border bg-popover/95 px-3.5 py-2 text-sm text-popover-foreground shadow-lg backdrop-blur-sm"
            >
              <span className="min-w-0 truncate">
                已移除「<span className="font-medium">{latest.label}</span>」
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => undoDelete(latest.id)}
                className="shrink-0 gap-1"
              >
                <RotateCcwIcon className="size-3" aria-hidden />
                撤销
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="立即确认移除"
                onClick={() => commitItem(latest.id)}
                className="shrink-0 text-muted-foreground"
              >
                <XIcon className="size-3.5" aria-hidden />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </SessionUndoContext.Provider>
  );
}

export function useSessionUndo() {
  return useContext(SessionUndoContext);
}
