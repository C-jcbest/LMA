import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useAui } from '@assistant-ui/react';

export type Page = 'home' | 'conversation' | 'stations' | 'records' | 'station' | 'lab';

interface NavigationLocation {
  page: Page;
  stationUuid: string | null;
  resultAnchor?: string;
}

interface NavigationValue extends NavigationLocation {
  goHome: () => void;
  showConversation: (resultAnchor?: string) => void;
  startConversation: () => void;
  returnFromStation: () => void;
  goStations: () => void;
  goRecords: () => void;
  goLab: () => void;
  openStation: (stationUuid: string) => void;
  showStationResult: (resultAnchor?: string) => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

const readLocation = (): NavigationLocation => {
  const params = new URL(window.location.href).searchParams;
  const stationUuid = params.get('station');
  if (stationUuid) {
    return { page: 'station', stationUuid, resultAnchor: params.get('result') ?? undefined };
  }
  const page = params.get('page');
  if (page === 'home' || page === 'stations' || page === 'records' || page === 'lab') {
    return { page, stationUuid: null };
  }
  return {
    page: page === 'conversation' || params.has('threadId') ? 'conversation' : 'home',
    stationUuid: null,
    resultAnchor: params.get('result') ?? undefined,
  };
};

const writeLocation = (location: NavigationLocation) => {
  const url = new URL(window.location.href);
  url.searchParams.delete('page');
  url.searchParams.delete('station');
  url.searchParams.delete('result');
  url.searchParams.delete('stationThread');
  if (location.page === 'station' && location.stationUuid) {
    url.searchParams.set('station', location.stationUuid);
  } else {
    url.searchParams.set('page', location.page);
  }
  if (location.resultAnchor) {
    url.searchParams.set('result', location.resultAnchor);
  }
  if (url.href !== window.location.href) {
    window.history.pushState(null, '', url);
  }
};

const switchPage = (update: () => void) => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || prefersReducedMotion) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
};

export function NavigationProvider({ children }: { children: ReactNode }) {
  const aui = useAui();
  const [location, setLocation] = useState(readLocation);
  const stationOrigin = useRef<NavigationLocation>({ page: 'stations', stationUuid: null });

  useEffect(() => {
    const onPopState = () => switchPage(() => setLocation(readLocation()));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: NavigationLocation) => {
    writeLocation(next);
    switchPage(() => setLocation(next));
  }, []);

  const value = useMemo<NavigationValue>(() => ({
    ...location,
    goHome: () => navigate({ page: 'home', stationUuid: null }),
    showConversation: (resultAnchor) => navigate({ page: 'conversation', stationUuid: null, resultAnchor }),
    startConversation: () => {
      void aui.threads().switchToNewThread();
      navigate({ page: 'conversation', stationUuid: null });
    },
    returnFromStation: () => navigate(stationOrigin.current),
    showStationResult: (resultAnchor) => {
      const url = new URL(window.location.href);
      if (resultAnchor) {
        url.searchParams.set('result', resultAnchor);
      } else {
        url.searchParams.delete('result');
      }
      window.history.replaceState(null, '', url);
      setLocation((current) => ({ ...current, resultAnchor }));
    },
    goStations: () => navigate({ page: 'stations', stationUuid: null }),
    goRecords: () => navigate({ page: 'records', stationUuid: null }),
    goLab: () => navigate({ page: 'lab', stationUuid: null }),
    openStation: (stationUuid) => {
      if (location.page !== 'station') {
        stationOrigin.current = location;
      }
      navigate({ page: 'station', stationUuid });
    },
  }), [aui, location, navigate]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error('NavigationProvider is required');
  }
  return value;
}
