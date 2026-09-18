import React from 'react';
import { PanelLeftOpen, Wifi, WifiOff } from 'lucide-react';

interface ChatHeaderProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  connectionStatus?: 'connected' | 'reconnecting' | 'recovered' | 'unavailable';
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  connectionStatus = 'connected',
}) => {
  return (
    <div className="h-12 px-5 flex items-center justify-between shrink-0 border-b border-neutral-100/80 bg-white/80 backdrop-blur-xs z-10">
      <div className="flex items-center gap-2">
        {isSidebarCollapsed && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 transition-colors"
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {connectionStatus === 'reconnecting' && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
            <span>重新连接中...</span>
          </div>
        )}
        {connectionStatus === 'unavailable' && (
          <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-2.5 py-1 rounded-full border border-red-200">
            <WifiOff className="w-3.5 h-3.5" />
            <span>服务未连接</span>
          </div>
        )}
      </div>
    </div>
  );
};
