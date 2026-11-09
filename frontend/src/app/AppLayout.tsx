import React, { useEffect, useRef, useState } from 'react';
import { useAuiEvent, useAuiState } from '@assistant-ui/react';
import { Mountain, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { ThreadList, ThreadListLoadError } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { StationInspector } from '@/features/monitoring/StationInspector';
import {
  StationInspectorProvider,
  useStationInspector,
} from '@/features/monitoring/StationInspectorContext';
import { useMediaQuery } from '@/hooks/use-media-query';

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
    {onOpenSettings && (
      <div className="shrink-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
        >
          <Settings className="size-4" />
          服务配置
        </Button>
      </div>
    )}
  </aside>
);

/** 只维护导航的展开状态；会话选择、消息和滚动仍由官方 Runtime 管理。 */
export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  return (
    <StationInspectorProvider>
      <AppLayoutContent onOpenSettings={onOpenSettings} />
    </StationInspectorProvider>
  );
};

const AppLayoutContent: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const { selection, isSplit, closeInspector } = useStationInspector();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const hasRoomForThreeColumns = useMediaQuery('(min-width: 1680px)');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const threadTitle = useAuiState((state) => (
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title || '新建会话'
  ));

  // 宽度放不下三栏时，会话导航让位给依据，改由抽屉打开。
  const canDockSidebar = isDesktop && (hasRoomForThreeColumns || !(isSplit && selection !== null));
  const isSidebarDocked = canDockSidebar && !isSidebarCollapsed;

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
      {isSidebarDocked && (
        <div className="h-full w-[260px] shrink-0 border-r">
          <SessionSidebar
            onClose={() => setIsSidebarCollapsed(true)}
            closeLabel="折叠侧边栏"
            onOpenSettings={openSettings}
          />
        </div>
      )}

      {!canDockSidebar && (
        <Dialog open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
          <DialogContent
            showCloseButton={false}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              navigationButtonRef.current?.focus();
            }}
            className="top-0 bottom-0 left-0 flex h-dvh w-[min(20rem,calc(100%-2rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 p-0"
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
          </DialogContent>
        </Dialog>
      )}

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {!isSidebarDocked && (
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)]">
            <Button
              ref={navigationButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (canDockSidebar) {
                  setIsSidebarCollapsed(false);
                } else {
                  setIsDrawerOpen(true);
                }
              }}
              aria-label={navigationLabel}
              title={navigationLabel}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
            <span className="min-w-0 truncate text-sm font-medium" title={threadTitle}>{threadTitle}</span>
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
