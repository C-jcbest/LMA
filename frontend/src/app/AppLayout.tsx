import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { useAuiEvent, useAuiState } from '@assistant-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityIcon, ListIcon, Mountain, PanelLeftClose, PanelLeftOpen, PlusIcon, Settings, SunIcon, type LucideIcon } from 'lucide-react';
import { ThreadList, ThreadListLoadError } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import { InspectionProvider, useInspection } from '@/features/inspection/InspectionContext';
import { StationInspector } from '@/features/monitoring/StationInspector';
import {
  StationInspectorProvider,
  useStationInspector,
} from '@/features/monitoring/StationInspectorContext';
import { RecordsPage } from '@/features/records/RecordsPage';
import { SessionConclusionsProvider } from '@/features/records/SessionConclusions';
import { SettingsMenu, type SettingsMenuActions } from '@/features/settings/SettingsMenu';
import { StationPage } from '@/features/stations/StationPage';
import { StationsPage } from '@/features/stations/StationsPage';
import { TodayPage } from '@/features/today/TodayPage';
import { NewInvestigation } from '@/features/today/NewInvestigation';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from 'cn';
import { NavigationProvider, useNavigation, type Page } from './navigation';
import { ThemeProvider } from './providers/ThemeProvider';

export interface AppLayoutProps {
  onOpenSettings?: () => void;
  onLogout?: () => void;
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
      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-98 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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

interface PageEntry {
  icon: LucideIcon;
  label: string;
  isCurrent: boolean;
  badge?: number;
  open: () => void;
}

function usePageEntries(): PageEntry[] {
  const { page, goHome, goStations, goRecords, startConversation } = useNavigation();
  const { latest } = useInspection();
  const isNewConversation = useAuiState((state) => state.thread.messages.length === 0);
  const attentionCount = latest?.stations.filter((station) => station.screening === '建议调查').length;
  return [
    { icon: PlusIcon, label: '新调查', isCurrent: page === 'conversation' && isNewConversation, open: startConversation },
    { icon: SunIcon, label: '今日', isCurrent: page === 'home' || page === 'lab', badge: attentionCount, open: goHome },
    { icon: ActivityIcon, label: '测点', isCurrent: page === 'stations' || page === 'station', open: goStations },
    { icon: ListIcon, label: '记录', isCurrent: page === 'records', open: goRecords },
  ];
}

const NavigationRail = forwardRef<HTMLButtonElement, SettingsMenuActions & { expandLabel: string; onExpand: () => void }>(({ expandLabel, onExpand, onOpenSettings, onLogout }, expandButtonRef) => {
  const entries = usePageEntries();
  return (
    <nav aria-label="快捷导航" data-navigation-rail="" className="flex h-full w-12 shrink-0 flex-col items-center gap-0.5 border-r bg-sidebar pt-[max(0.5rem,env(safe-area-inset-top))]">
      <Button ref={expandButtonRef} type="button" variant="ghost" size="icon" onClick={onExpand} aria-label={expandLabel} title={expandLabel}
        className="mb-2 text-muted-foreground hover:text-foreground">
        <PanelLeftOpen className="size-4" />
      </Button>
      {entries.map(({ icon: Icon, label, isCurrent, badge, open }) => (
        <button key={label} type="button" onClick={open} aria-label={label} title={label} aria-current={isCurrent ? 'page' : undefined}
          className={cn(
            'relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            isCurrent && 'bg-muted text-foreground',
          )}>
          <Icon className="size-4" aria-hidden />
          {badge !== undefined && badge > 0 && (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-attention" aria-hidden />
          )}
        </button>
      ))}
      <div className="mt-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <SettingsMenu side="right" onOpenSettings={onOpenSettings} onLogout={onLogout}>
          <button type="button" aria-label="设置" title="设置"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground">
            <Settings className="size-4" aria-hidden />
          </button>
        </SettingsMenu>
      </div>
    </nav>
  );
});
NavigationRail.displayName = 'NavigationRail';

const Sidebar: React.FC<SidebarProps> = ({ onClose, closeLabel, onNavigate, onOpenSettings, onLogout }) => {
  const { showConversation } = useNavigation();
  const entries = usePageEntries();

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
        {entries.map(({ icon, label, isCurrent, badge, open }) => (
          <NavigationItem key={label} icon={icon} label={label} isCurrent={isCurrent} badge={badge} onClick={go(open)} />
        ))}
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
      <div className="shrink-0 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <SettingsMenu side="top" onOpenSettings={onOpenSettings} onLogout={onLogout}>
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground"
          >
            <Settings className="size-4 shrink-0" aria-hidden />
            设置
          </button>
        </SettingsMenu>
      </div>
    </aside>
  );
};

export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings, onLogout }) => {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <NavigationProvider>
          <InspectionProvider>
            <SessionConclusionsProvider>
              <AppLayoutShell onOpenSettings={onOpenSettings} onLogout={onLogout} />
            </SessionConclusionsProvider>
          </InspectionProvider>
        </NavigationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

const AppLayoutShell: React.FC<AppLayoutProps> = ({ onOpenSettings, onLogout }) => {
  const { page } = useNavigation();
  return (
    <StationInspectorProvider canSplit={page === 'conversation'}>
      <AppLayoutContent onOpenSettings={onOpenSettings} onLogout={onLogout} />
    </StationInspectorProvider>
  );
};

const PAGE_TITLES: Record<Exclude<Page, 'home'>, string> = {
  conversation: '调查',
  stations: '测点',
  station: '测点',
  records: '调查记录',
  lab: '今日',
};

const AppLayoutContent: React.FC<AppLayoutProps> = ({ onOpenSettings, onLogout }) => {
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
  const [homeDraft, setHomeDraft] = useState('');
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

  const isInspectorBesideChat = isSplit && selection !== null;
  const isStationPageCramped = page === 'station' && !hasRoomForStationPage;
  const canDockSidebar = isDesktop && (hasRoomForThreeColumns || !(isInspectorBesideChat || isStationPageCramped));
  const isSidebarDocked = canDockSidebar && !isSidebarCollapsed;
  const setSidebarCollapsed = (collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    try {
      localStorage.setItem('lma-navigation-collapsed', String(collapsed));
    } catch {
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
  const showHeader = !isDesktop || page === 'conversation' || page === 'station';

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
              onLogout={onLogout}
            />
          </div>
          {isSidebarDocked && (
            <PanelResizeHandle label="调整导航宽度" panelId="session-navigation-docked" edge="right" {...navigationResize.handleProps} />
          )}
        </div>
      )}

      {isDesktop && !isSidebarDocked && (
        <NavigationRail
          ref={navigationButtonRef}
          expandLabel={navigationLabel}
          onOpenSettings={openSettings}
          onLogout={onLogout}
          onExpand={() => {
            if (canDockSidebar) {
              setSidebarCollapsed(false);
            } else {
              setIsDrawerOpen(true);
            }
          }}
        />
      )}

      {!canDockSidebar && (
        <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
          <SheetContent
            id="session-navigation-drawer"
            ref={drawerPanelRef}
            side="left"
            style={navigationResize.style}
            showCloseButton={false}
            onEscapeKeyDown={navigationResize.onEscapeKeyDown}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              navigationButtonRef.current?.focus();
            }}
            className="session-drawer gap-0 sm:max-w-none"
          >
            <SheetTitle className="sr-only">导航</SheetTitle>
            <SheetDescription className="sr-only">切换页面，或打开最近的调查。</SheetDescription>
            <ThreadListLoadError />
            <Sidebar
              onClose={() => setIsDrawerOpen(false)}
              closeLabel="关闭导航"
              onNavigate={() => setIsDrawerOpen(false)}
              onOpenSettings={openSettings}
              onLogout={onLogout}
            />
            <PanelResizeHandle label="调整导航宽度" panelId="session-navigation-drawer" edge="right" {...navigationResize.handleProps} />
          </SheetContent>
        </Sheet>
      )}

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: isSplit && selection !== null ? 360 : undefined }}>
        {showHeader && (
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)]">
            {!isDesktop && <Button
              ref={navigationButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsDrawerOpen(true)}
              aria-label={navigationLabel}
              title={navigationLabel}
            >
              <PanelLeftOpen className="size-4" />
            </Button>}
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={headerTitle}>{headerTitle}</span>
          </header>
        )}
        <ThreadListLoadError />
        <div className="min-h-0 flex-1 overflow-hidden">
          {(page === 'home' || page === 'lab') && <TodayPage draft={homeDraft} onDraftChange={setHomeDraft} initialScopedOpen={page === 'lab'} />}
          {page === 'conversation' && <Thread autoFocus={isDesktop} welcome={<NewInvestigation />} />}
          <div className="h-full" hidden={page !== 'stations'}><StationsPage active={page === 'stations'} /></div>
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
