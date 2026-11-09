import React, { useEffect, useRef, useState } from 'react';
import { useAuiEvent, useAuiState } from '@assistant-ui/react';
import { Mountain, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { ThreadList, ThreadListLoadError } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

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
  <aside aria-label="会话导航" className="flex h-full min-h-0 flex-col bg-neutral-50 pt-[env(safe-area-inset-top)] text-neutral-700">
    <div className="flex shrink-0 items-center justify-between border-b border-neutral-200/60 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-neutral-900 text-white shadow-xs">
          <Mountain className="size-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight text-neutral-800">LMA Monitor</span>
          <span className="text-[11px] text-neutral-400">滑坡连续监测智能体</span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="text-neutral-500 hover:text-neutral-700"
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
      <div className="shrink-0 border-t border-neutral-200/60 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-xs text-neutral-600 hover:text-neutral-900"
          onClick={onOpenSettings}
        >
          <Settings className="size-3.5" />
          服务配置
        </Button>
      </div>
    )}
  </aside>
);

/** 只维护导航的展开状态；会话选择、消息和滚动仍由官方 Runtime 管理。 */
export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const threadTitle = useAuiState((state) => (
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title || '新建会话'
  ));

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const handleChange = () => {
      setIsDesktop(media.matches);
      setIsMobileSidebarOpen(false);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useAuiEvent('threads.selectionChanged', () => setIsMobileSidebarOpen(false));

  const openSettings = onOpenSettings ? () => {
    setIsMobileSidebarOpen(false);
    onOpenSettings();
  } : undefined;

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white">
      {isDesktop && !isSidebarCollapsed && (
        <div className="h-full w-[260px] shrink-0 border-r border-neutral-200/80">
          <SessionSidebar
            onClose={() => setIsSidebarCollapsed(true)}
            closeLabel="折叠侧边栏"
            onOpenSettings={openSettings}
          />
        </div>
      )}

      {!isDesktop && (
        <Dialog open={isMobileSidebarOpen} onOpenChange={setIsMobileSidebarOpen}>
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
              onClose={() => setIsMobileSidebarOpen(false)}
              closeLabel="关闭会话列表"
              onNavigate={() => setIsMobileSidebarOpen(false)}
              onOpenSettings={openSettings}
            />
          </DialogContent>
        </Dialog>
      )}

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white text-neutral-800">
        {(!isDesktop || isSidebarCollapsed) && (
          <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-neutral-100 px-3 pt-[env(safe-area-inset-top)]">
            <Button
              ref={navigationButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (isDesktop) {
                  setIsSidebarCollapsed(false);
                } else {
                  setIsMobileSidebarOpen(true);
                }
              }}
              aria-label={isDesktop ? '展开侧边栏' : '打开会话列表'}
              title={isDesktop ? '展开侧边栏' : '打开会话列表'}
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
    </div>
  );
};
