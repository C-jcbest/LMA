import React, { useState } from 'react';
import { Mountain, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';

export interface AppLayoutProps {
  onOpenSettings?: () => void;
}

/**
 * 现代 AppLayout 布局：
 * 左侧 260px 会话栏（嵌入 assistant-ui ThreadList），右侧中央聊天区（嵌入 assistant-ui Thread）。
 * 保持白色背景、neutral 主色、轻量边框的既有视觉风格。
 */
export const AppLayout: React.FC<AppLayoutProps> = ({ onOpenSettings }) => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white">
      {/* 侧边栏：遵循左侧 260px 宽度，展示 LMA 品牌与 assistant-ui ThreadList */}
      {!isSidebarCollapsed && (
        <aside className="w-[260px] h-full flex flex-col bg-[#fafafa] border-r border-neutral-200/80 text-neutral-700 select-none shrink-0 transition-all">
          {/* Logo 区域 */}
          <div className="flex items-center justify-between px-3.5 py-3 border-b border-neutral-200/60">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-neutral-900 text-white flex items-center justify-center shadow-xs">
                <Mountain className="w-4 h-4" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-neutral-800 leading-tight">
                  LMA Monitor
                </span>
                <span className="text-[11px] text-neutral-400 font-normal">
                  滑坡连续监测智能体
                </span>
              </div>
            </div>
            <button
              onClick={() => setIsSidebarCollapsed(true)}
              className="p-1 rounded-md text-neutral-400 hover:text-neutral-600 hover:bg-neutral-200/60 transition-colors cursor-pointer"
              title="折叠侧边栏"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-hidden p-2">
            <ThreadList />
          </div>

          {/* 底部设置按钮 */}
          {onOpenSettings && (
            <div className="p-2 border-t border-neutral-200/60">
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-xs text-neutral-600 hover:text-neutral-900 cursor-pointer"
                onClick={onOpenSettings}
              >
                <Settings className="w-3.5 h-3.5" />
                服务配置
              </Button>
            </div>
          )}
        </aside>
      )}

      {/* 中央主聊天视口 */}
      <main className="flex-1 h-full flex flex-col bg-white text-neutral-800 relative overflow-hidden">
        {isSidebarCollapsed && (
          <div className="h-11 border-b border-neutral-100 flex items-center px-4 bg-white shrink-0">
            <button
              onClick={() => setIsSidebarCollapsed(false)}
              className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors cursor-pointer"
              title="展开侧边栏"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
            <span className="ml-3 text-xs font-medium text-neutral-500">
              LMA 滑坡监测智能体
            </span>
          </div>
        )}
        <div className="flex-1 h-full overflow-hidden">
          <Thread />
        </div>
      </main>
    </div>
  );
};
