import React, { useEffect, useRef, useState } from 'react';
import { useAuiEvent, useAuiState } from '@assistant-ui/react';
import { ActivityIcon, ListIcon, Mountain, PanelLeftClose, PanelLeftOpen, PlusIcon, Settings, SunIcon, type LucideIcon } from 'lucide-react';
import { ThreadList, ThreadListLoadError } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import { InspectionProvider, useInspection } from '@/features/inspection/InspectionContext';
import { StationInspector } from '@/features/monitoring/StationInspector';
import {
  StationInspectorProvider,
  useStationInspector,
} from '@/features/monitoring/StationInspectorContext';
import { RecordsPage } from '@/features/records/RecordsPage';
import { SessionConclusionsProvider } from '@/features/records/SessionConclusions';
import { ThemeSelector } from '@/features/settings/ThemeSelector';
import { StationPage } from '@/features/stations/StationPage';
import { StationsPage } from '@/features/stations/StationsPage';
import { TodayAttention } from '@/features/today/TodayAttention';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { NavigationProvider, useNavigation, type Page } from './navigation';
import { ThemeProvider } from './providers/ThemeProvider';

export interface AppLayoutProps {
  onOpenSettings?: () => void;
}

interface SidebarProps extends AppLayoutProps {
  onClose: () => void;
  closeLabel: string;
  onNavigate?: () => void;
}

const NavigationItem: React.FC<{
  icon: LucideIcon;
  label: string;
  isCurrent: boolean;
  badge?: number;
  onClick: () => void;
}> = ({ icon: Icon, label, isCurrent, badge, onClick }) => (
  <button
    type="button"
    aria-label={label}
    aria-current={isCurrent ? 'page' : undefined}
    onClick={onClick}
    className={cn(
      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      isCurrent && 'bg-muted font-medium text-foreground',
    )}
  >
    <Icon className="size-4 shrink-0" aria-hidden />
    {label}
    {badge !== undefined && badge > 0 && (
      <span className="ms-auto text-xs font-medium text-status-attention tabular-nums" title={`${badge} 个测点建议调查`}>{badge}</span>
    )}
  </button>
);

const Sidebar: React.FC<SidebarProps> = ({ onClose, closeLabel, onNavigate, onOpenSettings }) => {
  const { page, goHome, goStations, goRecords, showConversation, startConversation } = useNavigation();
  const { latest } = useInspection();
  const attentionCount = latest?.stations.filter((station) => station.screening === '建议调查').length;

  const go = (action: () => void) => () => {
    action();
    onNavigate?.();
  };

  return (
    <aside aria-label="导航" className="flex h-full min-h-0 flex-col bg-sidebar pt-[env(safe-area-inset-top)]">
      <div className="flex shrink-0 items-center justify-between px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Mountain className="size-5" aria-hidden />
          <span className="text-sm font-semibold">LMA Monitor</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title={closeLabel}
          aria-label={closeLabel}
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
      <nav aria-label="页面" className="shrink-0 space-y-0.5 px-2">
        <NavigationItem icon={PlusIcon} label="新调查" isCurrent={false} onClick={go(startConversation)} />
        <NavigationItem icon={SunIcon} label="今日" isCurrent={page === 'home'} badge={attentionCount} onClick={go(goHome)} />
        <NavigationItem icon={ActivityIcon} label="测点" isCurrent={page === 'stations' || page === 'station'} onClick={go(goStations)} />
        <NavigationItem icon={ListIcon} label="记录" isCurrent={page === 'records'} onClick={go(goRecords)} />
      </nav>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-5">
        <p className="shrink-0 px-2.5 pb-1.5 text-xs text-muted-foreground">最近</p>
        <div className="min-h-0 flex-1">
          <ThreadList
            variant="recent"
            onNavigate={() => {
              showConversation();
              onNavigate?.();
            }}
          />
        </div>
      </div>
      <div className="shrink-0 space-y-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {onOpenSettings && (
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="size-4" />
            服务配置
          </Button>
        )}
      </div>
    </aside>
  );
};

/** 只维护布局偏好和当前页面；会话选择、消息和滚动仍由官方 Runtime 管理。 */
export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  return (
    <ThemeProvider>
      <NavigationProvider>
        <InspectionProvider>
          <SessionConclusionsProvider>
            <AppLayoutShell onOpenSettings={onOpenSettings} />
          </SessionConclusionsProvider>
        </InspectionProvider>
      </NavigationProvider>
    </ThemeProvider>
  );
};

const AppLayoutShell: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const { page } = useNavigation();
  return (
    <StationInspectorProvider canSplit={page === 'conversation'}>
      <AppLayoutContent onOpenSettings={onOpenSettings} />
    </StationInspectorProvider>
  );
};

const PAGE_TITLES: Record<Exclude<Page, 'home'>, string> = {
  conversation: '调查',
  stations: '测点',
  station: '测点',
  records: '调查记录',
};

const AppLayoutContent: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const { page, stationUuid, showConversation } = useNavigation();
  const { selection, isSplit, closeInspector } = useStationInspector();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const hasRoomForThreeColumns = useMediaQuery('(min-width: 1680px)');
  const hasRoomForStationPage = useMediaQuery('(min-width: 1280px)');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('lma-navigation-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [runningStations, setRunningStations] = useState<ReadonlySet<string>>(new Set());
  const visibleStation = page === 'station' ? stationUuid : null;
  const mountedStations = new Set(runningStations);
  if (visibleStation) {
    mountedStations.add(visibleStation);
  }
  const navigationPanelRef = useRef<HTMLDivElement>(null);
  const drawerPanelRef = useRef<HTMLDivElement>(null);
  const navigationResize = usePanelResize({
    storageKey: 'lma-navigation-width',
    defaultWidth: 260,
    minWidth: 220,
    maxWidth: 420,
    side: 'left',
    panelRef: isDrawerOpen ? drawerPanelRef : navigationPanelRef,
    availableWidth: () => window.innerWidth - (window.innerWidth >= 768 ? 360 : 32),
  });
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const threadTitle = useAuiState((state) => (
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title || '新调查'
  ));

  // 宽度放不下三栏时，导航让位给依据或测点页的对话，改由抽屉打开。依据面板比测点页的对话栏宽，需要更多空间。
  const isInspectorBesideChat = isSplit && selection !== null;
  const isStationPageCramped = page === 'station' && !hasRoomForStationPage;
  const canDockSidebar = isDesktop && (hasRoomForThreeColumns || !(isInspectorBesideChat || isStationPageCramped));
  const isSidebarDocked = canDockSidebar && !isSidebarCollapsed;
  const setSidebarCollapsed = (collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    try {
      localStorage.setItem('lma-navigation-collapsed', String(collapsed));
    } catch {
      // 折叠仍即时生效；禁用存储的浏览器无法跨刷新保留偏好。
    }
    requestAnimationFrame(() => {
      if (collapsed) {
        navigationButtonRef.current?.focus();
      } else {
        navigationPanelRef.current?.querySelector<HTMLButtonElement>('button[aria-label="折叠侧边栏"]')?.focus();
      }
    });
  };

  useEffect(() => {
    setIsDrawerOpen(false);
  }, [canDockSidebar]);

  useAuiEvent('threads.selectionChanged', () => {
    setIsDrawerOpen(false);
    closeInspector();
  });
  useAuiEvent('thread.runStart', () => {
    if (page === 'home') {
      showConversation();
    }
  });

  const openSettings = onOpenSettings ? () => {
    setIsDrawerOpen(false);
    onOpenSettings();
  } : undefined;

  const navigationLabel = canDockSidebar ? '展开侧边栏' : '打开导航';
  const headerTitle = page === 'conversation' ? threadTitle : page === 'home' ? '今日' : PAGE_TITLES[page];

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      {isDesktop && (
        <div
          id="session-navigation-docked"
          ref={navigationPanelRef}
          data-navigation-docked=""
          data-state={isSidebarDocked ? 'open' : 'closed'}
          aria-hidden={!isSidebarDocked}
          inert={!isSidebarDocked}
          style={navigationResize.style}
          className="navigation-panel relative h-full shrink-0"
        >
          <div className="panel-inner h-full overflow-hidden border-r">
            <Sidebar
              onClose={() => setSidebarCollapsed(true)}
              closeLabel="折叠侧边栏"
              onOpenSettings={openSettings}
            />
          </div>
          {isSidebarDocked && (
            <PanelResizeHandle label="调整导航宽度" panelId="session-navigation-docked" edge="right" {...navigationResize.handleProps} />
          )}
        </div>
      )}

      {!canDockSidebar && (
        <Dialog open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
          <DialogContent
            id="session-navigation-drawer"
            ref={drawerPanelRef}
            style={navigationResize.style}
            showCloseButton={false}
            onEscapeKeyDown={navigationResize.onEscapeKeyDown}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              navigationButtonRef.current?.focus();
            }}
            className="session-drawer top-0 bottom-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 p-0"
          >
            <DialogTitle className="sr-only">导航</DialogTitle>
            <DialogDescription className="sr-only">切换页面，或打开最近的调查。</DialogDescription>
            <ThreadListLoadError />
            <Sidebar
              onClose={() => setIsDrawerOpen(false)}
              closeLabel="关闭导航"
              onNavigate={() => setIsDrawerOpen(false)}
              onOpenSettings={openSettings}
            />
            <PanelResizeHandle label="调整导航宽度" panelId="session-navigation-drawer" edge="right" {...navigationResize.handleProps} />
          </DialogContent>
        </Dialog>
      )}

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: isSplit && selection !== null ? 360 : undefined }}>
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)]">
            {!isSidebarDocked && <Button
              ref={navigationButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (canDockSidebar) {
                  setSidebarCollapsed(false);
                } else {
                  setIsDrawerOpen(true);
                }
              }}
              aria-label={navigationLabel}
              title={navigationLabel}
            >
              <PanelLeftOpen className="size-4" />
            </Button>}
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={headerTitle}>{headerTitle}</span>
            <ThemeSelector />
          </header>
        <ThreadListLoadError />
        <div className="min-h-0 flex-1 overflow-hidden">
          {(page === 'home' || page === 'conversation') && <Thread autoFocus={isDesktop} overview={page === 'home' ? <TodayAttention /> : undefined} />}
          <div className="h-full" hidden={page !== 'stations'}><StationsPage /></div>
          {page === 'records' && <RecordsPage />}
          {[...mountedStations].map((id) => (
            <div key={id} className="h-full" hidden={id !== visibleStation}>
              <StationPage stationUuid={id} active={id === visibleStation} onRunningChange={(running) => {
                setRunningStations((current) => {
                  const next = new Set(current);
                  if (running) {
                    next.add(id);
                  } else {
                    next.delete(id);
                  }
                  return next;
                });
              }} />
            </div>
          ))}
        </div>
      </main>

      <StationInspector />
    </div>
  );
};
