import { useAui } from '@assistant-ui/react';
import { addAskTarget, type AskTarget } from './ask-targets';
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

export interface InspectorSelection {
  messageId: string;
  stationId?: string;
  toolCallId?: string;
}

export interface StationSelection extends InspectorSelection {
  stationId: string;
}

export interface EvidenceSelection extends InspectorSelection {
  toolCallId: string;
}

interface StationInspectorContextValue {
  selection: InspectorSelection | null;
  selectionVersion: number;
  isClosing: boolean;
  isSplit: boolean;
  canExpand: boolean;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  viewStates: RefObject<Map<string, InspectorViewState>>;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  attachAskTarget: (target: AskTarget) => void;
  openStation: (selection: StationSelection) => void;
  openEvidence: (selection: EvidenceSelection) => void;
  closeInspector: (options?: { focusComposer?: boolean }) => void;
  finishClose: () => void;
}

const StationInspectorContext = createContext<StationInspectorContextValue | null>(null);

export function StationInspectorProvider({ children, canSplit = true }: { children: ReactNode; canSplit?: boolean }) {
  const aui = useAui();
  const attachAskTarget = useCallback((target: AskTarget) => addAskTarget(aui, target), [aui]);
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewStates = useRef(new Map<string, InspectorViewState>());
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isWide = useMediaQuery('(min-width: 1024px)');
  const canExpand = canSplit && isWide;
  const isSplit = canExpand && !isFullscreen;
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const readingPosition = useRef<{ viewport: HTMLElement; offset: number } | null>(null);
  const restoreReadingPosition = useRef(false);

  const open = useCallback((next: InspectorSelection) => {
    setSelectionVersion((version) => version + 1);
    const saved = next.stationId ? viewStates.current.get(`${next.messageId}:${next.stationId}`) : undefined;
    if (saved && next.toolCallId) {
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

  const finishClose = useCallback(() => {
    setSelection(null);
    setIsClosing(false);
    setIsFullscreen(false);
  }, []);

  const toggleFullscreen = useCallback(() => setIsFullscreen((current) => !current), []);

  useEffect(() => {
    if (!isClosing) {
      return;
    }
    const timer = window.setTimeout(finishClose, reduceMotion ? 0 : 400);
    return () => window.clearTimeout(timer);
  }, [isClosing, reduceMotion, finishClose]);

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
    () => ({
      selection, selectionVersion, isClosing, isSplit, canExpand, isFullscreen, toggleFullscreen, viewStates, composerInputRef, attachAskTarget,
      openStation: open, openEvidence: open, closeInspector, finishClose,
    }),
    [selection, selectionVersion, isClosing, isSplit, canExpand, isFullscreen, toggleFullscreen, attachAskTarget, open, closeInspector, finishClose],
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
