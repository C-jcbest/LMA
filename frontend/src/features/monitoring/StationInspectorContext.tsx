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
  const isSplit = useMediaQuery('(min-width: 1024px)');
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);

  const openStation = useCallback((next: StationSelection) => {
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
    setSelection(null);
  }, []);

  useEffect(() => {
    if (selection !== null) return;
    const target = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, [selection]);

  const value = useMemo(
    () => ({ selection, isSplit, composerInputRef, openStation, closeInspector }),
    [selection, isSplit, openStation, closeInspector],
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
