import React from 'react';
import { Menu, PanelLeftOpen, WifiOff, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';

export interface ChatHeaderProps {
  title?: string;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onOpenMobileSidebar?: () => void;
  connectionStatus?: 'connected' | 'reconnecting' | 'recovered' | 'unavailable';
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  title = '新监测分析会话',
  isSidebarCollapsed = false,
  onToggleSidebar,
  onOpenMobileSidebar,
  connectionStatus = 'connected',
}) => {
  return (
    <header className="h-12 px-4 flex items-center justify-between border-b border-neutral-200/80 bg-white/90 backdrop-blur-xs z-10 shrink-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* 移动端汉堡菜单 */}
        {onOpenMobileSidebar && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onOpenMobileSidebar}
            className="md:hidden h-8 w-8 text-neutral-600 hover:text-neutral-900 cursor-pointer"
            title="打开历史会话"
            aria-label="打开历史会话"
          >
            <Menu className="w-4 h-4" />
          </Button>
        )}

        {/* 桌面端折叠时显示展开侧边栏按钮 */}
        {isSidebarCollapsed && onToggleSidebar && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="hidden md:flex h-8 w-8 text-neutral-600 hover:text-neutral-900 cursor-pointer"
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </Button>
        )}

        <h1 className="text-xs font-semibold text-neutral-800 truncate">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {connectionStatus === 'reconnecting' && (
          <Badge variant="outline" className="text-[11px] gap-1.5 text-amber-600 border-amber-200 bg-amber-50 py-0.5">
            <Loader2 className="w-3 h-3 animate-spin text-amber-600" />
            <span>重新连接中…</span>
          </Badge>
        )}

        {connectionStatus === 'unavailable' && (
          <Badge variant="destructive" className="text-[11px] gap-1.5 py-0.5">
            <WifiOff className="w-3 h-3" />
            <span>服务未连接</span>
          </Badge>
        )}
      </div>
    </header>
  );
};
