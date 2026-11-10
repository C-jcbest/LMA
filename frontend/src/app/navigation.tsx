import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAui } from '@assistant-ui/react';

export type Page = 'home' | 'conversation' | 'stations' | 'records' | 'station';

interface NavigationLocation {
  page: Page;
  stationUuid: string | null;
  resultAnchor?: string;
}

interface NavigationValue extends NavigationLocation {
  /** 页面导航不改变当前会话。 */
  goHome: () => void;
  /** 回到对话区，保留当前会话。 */
  showConversation: (resultAnchor?: string) => void;
  startConversation: () => void;
  returnFromStation: () => void;
  goStations: () => void;
  goRecords: () => void;
  openStation: (stationUuid: string) => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

const readLocation = (): NavigationLocation => {
  const params = new URL(window.location.href).searchParams;
  const stationUuid = params.get('station');
  if (stationUuid) {
    return { page: 'station', stationUuid };
  }
  const page = params.get('page');
  if (page === 'home' || page === 'stations' || page === 'records') {
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

/** 只保存用户在看哪一页；会话选择仍由官方 Runtime 管理，并各自写入地址栏。 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const aui = useAui();
  const [location, setLocation] = useState(readLocation);
  const stationOrigin = useRef<NavigationLocation>({ page: 'stations', stationUuid: null });

  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: NavigationLocation) => {
    setLocation(next);
    writeLocation(next);
  }, []);

  const value = useMemo<NavigationValue>(() => ({
    ...location,
    goHome: () => navigate({ page: 'home', stationUuid: null }),
    showConversation: (resultAnchor) => navigate({ page: 'conversation', stationUuid: null, resultAnchor }),
    startConversation: () => {
      void aui.threads().switchToNewThread();
      if (location.page !== 'station') {
        navigate({ page: 'conversation', stationUuid: null });
      }
    },
    returnFromStation: () => navigate(stationOrigin.current),
    goStations: () => navigate({ page: 'stations', stationUuid: null }),
    goRecords: () => navigate({ page: 'records', stationUuid: null }),
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
