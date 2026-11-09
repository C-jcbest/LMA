import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';

export interface StationSelection {
  messageId: string;
  stationName: string;
  /** 从简报依据进入时，定位到这条工具结果。 */
  toolCallId?: string;
}

interface StationInspectorContextValue {
  selection: StationSelection | null;
  isClosing: boolean;
  /** 宽度足够时检查器与对话并排，否则全屏覆盖。 */
  isSplit: boolean;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  openStation: (selection: StationSelection) => void;
  closeInspector: (options?: { focusComposer?: boolean }) => void;
}

const StationInspectorContext = createContext<StationInspectorContextValue | null>(null);

/** 只保存打开的位置；证据始终从当前消息的官方 tool part 派生。 */
export function StationInspectorProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<StationSelection | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isSplit = useMediaQuery('(min-width: 1024px)');
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);

  const openStation = useCallback((next: StationSelection) => {
    setIsClosing(false);
    setSelection((current) => {
      if (current === null) {
        focusAfterCloseRef.current = document.activeElement as HTMLElement | null;
      }
      return next;
    });
  }, []);

  const closeInspector = useCallback((options?: { focusComposer?: boolean }) => {
    if (options?.focusComposer) {
      focusAfterCloseRef.current = composerInputRef.current;
    }
    setIsClosing(true);
  }, []);

  useEffect(() => {
    if (!isClosing) {
      return;
    }
    // 保留依据到退场结束，避免立即卸载截断关闭动画；新打开会取消这次退场。
    const timer = window.setTimeout(() => {
      setSelection(null);
      setIsClosing(false);
    }, reduceMotion ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [isClosing, reduceMotion]);

  useEffect(() => {
    if (selection !== null) return;
    const target = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, [selection]);

  const value = useMemo(
    () => ({ selection, isClosing, isSplit, composerInputRef, openStation, closeInspector }),
    [selection, isClosing, isSplit, openStation, closeInspector],
  );

  return (
    <StationInspectorContext.Provider value={value}>
      {children}
    </StationInspectorContext.Provider>
  );
}

export function useStationInspector() {
  const value = useContext(StationInspectorContext);
  if (!value) {
    throw new Error('StationInspectorProvider is required');
  }
  return value;
}
