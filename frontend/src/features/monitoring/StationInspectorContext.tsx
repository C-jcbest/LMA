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
import type { ChartViewState } from './TimelineChart';
import type { TimelineMode } from './timeline';

export interface InspectorViewState {
  selectedToolCallId?: string;
  tab?: string;
  mode?: TimelineMode;
  charts: Map<string, ChartViewState>;
}

export interface StationSelection {
  messageId: string;
  stationId: string;
  /** 从简报依据进入时，定位到这条工具结果。 */
  toolCallId?: string;
}

interface StationInspectorContextValue {
  selection: StationSelection | null;
  selectionVersion: number;
  isClosing: boolean;
  /** 宽度足够时检查器与对话并排，否则全屏覆盖。 */
  isSplit: boolean;
  canExpand: boolean;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  viewStates: RefObject<Map<string, InspectorViewState>>;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  openStation: (selection: StationSelection) => void;
  closeInspector: (options?: { focusComposer?: boolean }) => void;
}

const StationInspectorContext = createContext<StationInspectorContextValue | null>(null);

/** 保存查看位置和图表交互状态；证据始终从当前消息的官方 tool part 派生。 */
export function StationInspectorProvider({ children, canSplit = true }: { children: ReactNode; canSplit?: boolean }) {
  const [selection, setSelection] = useState<StationSelection | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewStates = useRef(new Map<string, InspectorViewState>());
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // 测点页已经是数据与对话并排，依据在那里全屏打开，不再挤出第四栏。
  const isWide = useMediaQuery('(min-width: 1024px)');
  const canExpand = canSplit && isWide;
  const isSplit = canExpand && !isFullscreen;
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const readingPosition = useRef<{ viewport: HTMLElement; offset: number } | null>(null);
  const restoreReadingPosition = useRef(false);

  const openStation = useCallback((next: StationSelection) => {
    setSelectionVersion((version) => version + 1);
    const saved = viewStates.current.get(`${next.messageId}:${next.stationId}`);
    if (saved && next.toolCallId) {
      // 引用必须定位指定证据；保留该证据自身的缩放和图例。
      saved.selectedToolCallId = next.toolCallId;
      saved.tab = undefined;
    }
    setIsClosing(false);
    const target = document.activeElement as HTMLElement | null;
    if (!target?.closest('[data-station-inspector]')) {
      focusAfterCloseRef.current = target;
      const viewport = target?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
      readingPosition.current = target && viewport
        ? { viewport, offset: target.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
        : null;
    }
    setSelection(next);
  }, []);

  const closeInspector = useCallback((options?: { focusComposer?: boolean }) => {
    restoreReadingPosition.current = !isSplit && !options?.focusComposer;
    if (options?.focusComposer) {
      focusAfterCloseRef.current = composerInputRef.current;
    }
    setIsClosing(true);
  }, [isSplit]);

  const toggleFullscreen = useCallback(() => setIsFullscreen((current) => !current), []);

  useEffect(() => {
    if (!isClosing) {
      return;
    }
    // 保留依据到退场结束，避免立即卸载截断关闭动画；新打开会取消这次退场。
    const timer = window.setTimeout(() => {
      setSelection(null);
      setIsClosing(false);
      setIsFullscreen(false);
    }, reduceMotion ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [isClosing, reduceMotion]);

  useEffect(() => {
    if (selection !== null) return;
    const target = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    if (target?.isConnected) {
      const reading = readingPosition.current;
      if (restoreReadingPosition.current && reading) {
        target.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          if (target.isConnected && reading.viewport.isConnected) {
            reading.viewport.scrollTop += target.getBoundingClientRect().top - reading.viewport.getBoundingClientRect().top - reading.offset;
          }
        });
      } else {
        target.focus({ preventScroll: target !== composerInputRef.current });
      }
    }
  }, [selection]);

  const value = useMemo(
    () => ({ selection, selectionVersion, isClosing, isSplit, canExpand, isFullscreen, toggleFullscreen, viewStates, composerInputRef, openStation, closeInspector }),
    [selection, selectionVersion, isClosing, isSplit, canExpand, isFullscreen, toggleFullscreen, openStation, closeInspector],
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
