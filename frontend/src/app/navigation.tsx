import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAui } from '@assistant-ui/react';

export type Page = 'home' | 'stations' | 'records' | 'station';

interface NavigationLocation {
  page: Page;
  stationUuid: string | null;
}

interface NavigationValue extends NavigationLocation {
  /** 回到首页并开始一段新对话。 */
  goHome: () => void;
  /** 回到对话区，保留当前会话。 */
  showConversation: () => void;
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
  if (page === 'stations' || page === 'records') {
    return { page, stationUuid: null };
  }
  return { page: 'home', stationUuid: null };
};

const writeLocation = (location: NavigationLocation) => {
  const url = new URL(window.location.href);
  url.searchParams.delete('page');
  url.searchParams.delete('station');
  if (location.page === 'station' && location.stationUuid) {
    url.searchParams.set('station', location.stationUuid);
  } else if (location.page !== 'home') {
    url.searchParams.set('page', location.page);
  }
  if (url.href !== window.location.href) {
    window.history.pushState(null, '', url);
  }
};

/** 只保存用户在看哪一页；会话选择仍由官方 Runtime 管理，并各自写入地址栏。 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const aui = useAui();
  const [location, setLocation] = useState(readLocation);

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
    goHome: () => {
      void aui.threads().switchToNewThread();
      navigate({ page: 'home', stationUuid: null });
    },
    showConversation: () => navigate({ page: 'home', stationUuid: null }),
    goStations: () => navigate({ page: 'stations', stationUuid: null }),
    goRecords: () => navigate({ page: 'records', stationUuid: null }),
    openStation: (stationUuid) => {
      // 进入测点页时右侧是一段新对话；历次调查从测点的记录里打开。
      void aui.threads().switchToNewThread();
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
