import React, { useEffect, useRef, useState } from 'react';
import { useAuiEvent, useAuiState } from '@assistant-ui/react';
import { Mountain, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { ThreadList, ThreadListLoadError } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import { ThemeSelector } from '@/features/settings/ThemeSelector';
import { StationInspector } from '@/features/monitoring/StationInspector';
import {
  StationInspectorProvider,
  useStationInspector,
} from '@/features/monitoring/StationInspectorContext';
import { useMediaQuery } from '@/hooks/use-media-query';
import { ThemeProvider } from './providers/ThemeProvider';

export interface AppLayoutProps {
  onOpenSettings?: () => void;
}

interface SessionSidebarProps extends AppLayoutProps {
  onClose: () => void;
  closeLabel: string;
  onNavigate?: () => void;
}

const SessionSidebar: React.FC<SessionSidebarProps> = ({
  onClose,
  closeLabel,
  onNavigate,
  onOpenSettings,
}) => (
  <aside aria-label="会话导航" className="flex h-full min-h-0 flex-col bg-sidebar pt-[env(safe-area-inset-top)]">
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
    <div className="min-h-0 flex-1 overflow-hidden p-2">
      <ThreadList onNavigate={onNavigate} />
    </div>
    <div className="shrink-0 space-y-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-between px-1.5">
        <span className="text-sm text-muted-foreground">外观</span>
        <ThemeSelector />
      </div>
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

/** 只维护布局偏好；会话选择、消息和滚动仍由官方 Runtime 管理。 */
export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  return (
    <ThemeProvider>
      <StationInspectorProvider>
        <AppLayoutContent onOpenSettings={onOpenSettings} />
      </StationInspectorProvider>
    </ThemeProvider>
  );
};

const AppLayoutContent: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const { selection, isSplit, closeInspector } = useStationInspector();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const hasRoomForThreeColumns = useMediaQuery('(min-width: 1680px)');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('lma-navigation-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
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
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title || '新建会话'
  ));

  // 宽度放不下三栏时，会话导航让位给依据，改由抽屉打开。
  const canDockSidebar = isDesktop && (hasRoomForThreeColumns || !(isSplit && selection !== null));
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

  const openSettings = onOpenSettings ? () => {
    setIsDrawerOpen(false);
    onOpenSettings();
  } : undefined;

  const navigationLabel = canDockSidebar ? '展开侧边栏' : '打开会话列表';

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
            <SessionSidebar
              onClose={() => setSidebarCollapsed(true)}
              closeLabel="折叠侧边栏"
              onOpenSettings={openSettings}
            />
          </div>
          {isSidebarDocked && (
            <PanelResizeHandle label="调整会话列表宽度" panelId="session-navigation-docked" edge="right" {...navigationResize.handleProps} />
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
            <DialogTitle className="sr-only">会话列表</DialogTitle>
            <DialogDescription className="sr-only">选择已有会话，或新建监测调查。</DialogDescription>
            <ThreadListLoadError />
            <SessionSidebar
              onClose={() => setIsDrawerOpen(false)}
              closeLabel="关闭会话列表"
              onNavigate={() => setIsDrawerOpen(false)}
              onOpenSettings={openSettings}
            />
            <PanelResizeHandle label="调整会话列表宽度" panelId="session-navigation-drawer" edge="right" {...navigationResize.handleProps} />
          </DialogContent>
        </Dialog>
      )}

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden" style={{ minWidth: isSplit && selection !== null ? 360 : undefined }}>
        {!isSidebarDocked && (
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)]">
            <Button
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
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={threadTitle}>{threadTitle}</span>
            <ThemeSelector />
          </header>
        )}
        <ThreadListLoadError />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Thread autoFocus={isDesktop} />
        </div>
      </main>

      <StationInspector />
    </div>
  );
};
