import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import type { LatestInspection } from '@/services/api';

const POLL_INTERVAL_MS = 2000;

interface InspectionValue {
  latest: LatestInspection | null;
  isLoading: boolean;
  hasLoadError: boolean;
  isStarting: boolean;
  hasStartError: boolean;
  reload: () => void;
  start: () => void;
}

const InspectionContext = createContext<InspectionValue | null>(null);

/** 今日页、测点列表和测点页读取同一份巡检结果，切换页面不重复请求。 */
export function InspectionProvider({ children }: { children: ReactNode }) {
  const client = useLmaClient();
  const [latest, setLatest] = useState<LatestInspection | null>(null);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [hasStartError, setHasStartError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (abortRef.current) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
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
    if (!isRunning || isLoading) {
      return;
    }
    // 请求结束后才开始计时，慢接口不会被下一轮取消，也不累积并发请求。
    const timer = window.setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isRunning, isLoading, load]);

  const start = useCallback(async () => {
    setIsStarting(true);
    setHasStartError(false);
    try {
      await client.startInspection();
      await load();
    } catch {
      setHasStartError(true);
    } finally {
      setIsStarting(false);
    }
  }, [client, load]);

  const value = useMemo<InspectionValue>(() => ({
    latest,
    isLoading,
    hasLoadError,
    isStarting,
    hasStartError,
    reload: () => void load(),
    start: () => void start(),
  }), [latest, isLoading, hasLoadError, isStarting, hasStartError, load, start]);

  return <InspectionContext.Provider value={value}>{children}</InspectionContext.Provider>;
}

export function useInspection() {
  const value = useContext(InspectionContext);
  if (!value) {
    throw new Error('InspectionProvider is required');
  }
  return value;
}
