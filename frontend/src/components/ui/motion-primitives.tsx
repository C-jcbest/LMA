import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RotateCcwIcon, XIcon } from 'lucide-react';
import { Button } from './button';

export const SPRING_SNAPPY = { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 } as const;
export const SPRING_PANEL = { type: 'spring', stiffness: 360, damping: 34, mass: 0.9 } as const;
export const EASE_OUT = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;
export const EASE_IN = { duration: 0.14, ease: [0.4, 0, 1, 1] } as const;

export function MorphIcon({ activeKey, children }: { activeKey: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={activeKey}
        initial={{ opacity: 0, scale: 0.72 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] } }}
        exit={{ opacity: 0, scale: 0.72, transition: { duration: 0.08, ease: [0.4, 0, 1, 1] } }}
        className="inline-flex items-center justify-center"
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

interface PendingDelete {
  id: string;
  label: string;
  detail?: string;
  commit: () => Promise<void>;
  timerId: number | null;
  remainingMs: number;
  startedAt: number;
  paused: boolean;
}

interface SessionUndoContextValue {
  pendingIds: ReadonlySet<string>;
  scheduleDelete: (id: string, label: string, commit: () => Promise<void>, detail?: string) => void;
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
    if (item.timerId !== null) window.clearTimeout(item.timerId);
    setPending((current) => current.filter((entry) => entry.id !== id));
    void item.commit().catch(() => {});
  }, []);

  const undoDelete = useCallback((id: string) => {
    const item = pendingRef.current.find((entry) => entry.id === id);
    if (!item) return;
    if (item.timerId !== null) window.clearTimeout(item.timerId);
    setPending((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const scheduleDelete = useCallback((id: string, label: string, commit: () => Promise<void>, detail?: string) => {
    if (pendingRef.current.some((entry) => entry.id === id)) return;
    const timerId = window.setTimeout(() => commitItem(id), UNDO_DELAY_MS);
    setPending((current) => [
      ...current,
      { id, label, detail, commit, timerId, remainingMs: UNDO_DELAY_MS, startedAt: Date.now(), paused: false },
    ]);
  }, [commitItem]);

  const setPaused = useCallback((id: string, paused: boolean) => {
    setPending((current) => current.map((item) => {
      if (item.id !== id || item.paused === paused) return item;
      if (paused) {
        if (item.timerId !== null) window.clearTimeout(item.timerId);
        const elapsed = Date.now() - item.startedAt;
        return { ...item, timerId: null, remainingMs: Math.max(400, item.remainingMs - elapsed), paused: true };
      }
      const timerId = window.setTimeout(() => commitItem(id), item.remainingMs);
      return { ...item, timerId, startedAt: Date.now(), paused: false };
    }));
  }, [commitItem]);

  useEffect(() => {
    const flushAll = () => {
      for (const item of pendingRef.current) {
        if (item.timerId !== null) window.clearTimeout(item.timerId);
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
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.96 }}
              transition={SPRING_SNAPPY}
              onMouseEnter={() => setPaused(latest.id, true)}
              onMouseLeave={() => setPaused(latest.id, false)}
              onFocus={() => setPaused(latest.id, true)}
              onBlur={() => setPaused(latest.id, false)}
              className="pointer-events-auto relative flex max-w-md items-center gap-3 overflow-hidden rounded-xl border bg-popover/95 px-3.5 py-2.5 text-sm text-popover-foreground shadow-lg backdrop-blur-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  已移除「<span className="font-medium">{latest.label}</span>」
                </p>
                {latest.detail && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{latest.detail}</p>
                )}
              </div>
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
              <motion.span
                key={`${latest.id}:${latest.paused ? 'paused' : 'running'}`}
                aria-hidden
                initial={{ scaleX: latest.remainingMs / UNDO_DELAY_MS }}
                animate={{ scaleX: latest.paused ? latest.remainingMs / UNDO_DELAY_MS : 0 }}
                transition={{ duration: latest.paused ? 0 : latest.remainingMs / 1000, ease: 'linear' }}
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground/25"
              />
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
