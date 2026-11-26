import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import type { LatestInspection } from '@/services/api';

const POLL_INTERVAL_MS = 2000;

interface InspectionValue {
  latest: LatestInspection | null;
  isLoading: boolean;
  hasLoadError: boolean;
  isStarting: boolean;
  isCancelling: boolean;
  hasStartError: boolean;
  reload: () => void;
  start: () => void;
  cancel: () => void;
}

const InspectionContext = createContext<InspectionValue | null>(null);

export function InspectionProvider({ children }: { children: ReactNode }) {
  const client = useLmaClient();
  const [latest, setLatest] = useState<LatestInspection | null>(null);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [hasStartError, setHasStartError] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (abortRef.current) {
      if (!options?.force) {
        return;
      }
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    if (!options?.silent) {
      setIsLoading(true);
    }
    try {
      const result = await client.getLatestInspection(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setLatest(result);
      setHasLoadError(false);
    } catch {
      if (!controller.signal.aborted) {
        setHasLoadError(true);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoading(false);
        setPollTick((tick) => tick + 1);
      }
    }
  }, [client]);

  useEffect(() => {
    setLatest(null);
    void load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const isRunning = latest?.running != null;
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const timer = window.setTimeout(() => void load({ silent: true }), POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isRunning, pollTick, load]);

  const start = useCallback(async () => {
    setIsStarting(true);
    setHasStartError(false);
    try {
      await client.startInspection();
      await load({ force: true, silent: true });
    } catch {
      setHasStartError(true);
    } finally {
      setIsStarting(false);
    }
  }, [client, load]);

  const cancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      await client.cancelInspection();
      await load({ force: true, silent: true });
    } catch {
    } finally {
      setIsCancelling(false);
    }
  }, [client, load]);

  const value = useMemo<InspectionValue>(() => ({
    latest,
    isLoading,
    hasLoadError,
    isStarting,
    isCancelling,
    hasStartError,
    reload: () => void load({ force: true, silent: latest !== null }),
    start: () => void start(),
    cancel: () => void cancel(),
  }), [latest, isLoading, hasLoadError, isStarting, isCancelling, hasStartError, load, start, cancel]);

  return <InspectionContext.Provider value={value}>{children}</InspectionContext.Provider>;
}

export function useInspection() {
  const value = useContext(InspectionContext);
  if (!value) {
    throw new Error('InspectionProvider is required');
  }
  return value;
}
