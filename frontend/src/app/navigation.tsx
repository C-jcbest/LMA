import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

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
  /** 新调查从首页开始：回到首页并让输入框获得焦点。 */
  startConversation: () => void;
  /** 每次请求聚焦首页输入框时加一，首页据此聚焦。 */
  homeFocusRequest: number;
  returnFromStation: () => void;
  goStations: () => void;
  goRecords: () => void;
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

/** 换页时用浏览器的视图过渡做一次短暂的淡入淡出；浏览器不支持或用户减弱动效时直接切换。 */
const switchPage = (update: () => void) => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || prefersReducedMotion) {
    update();
    return;
  }
  // 浏览器在回调里截取新页面，React 必须在回调返回前完成渲染。
  document.startViewTransition(() => flushSync(update));
};

/** 只保存用户在看哪一页；会话选择仍由官方 Runtime 管理，并各自写入地址栏。 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(readLocation);
  const [homeFocusRequest, setHomeFocusRequest] = useState(0);
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
    homeFocusRequest,
    goHome: () => navigate({ page: 'home', stationUuid: null }),
    showConversation: (resultAnchor) => navigate({ page: 'conversation', stationUuid: null, resultAnchor }),
    startConversation: () => {
      navigate({ page: 'home', stationUuid: null });
      setHomeFocusRequest((count) => count + 1);
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
    openStation: (stationUuid) => {
      if (location.page !== 'station') {
        stationOrigin.current = location;
      }
      navigate({ page: 'station', stationUuid });
    },
  }), [location, navigate, homeFocusRequest]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error('NavigationProvider is required');
  }
  return value;
}
