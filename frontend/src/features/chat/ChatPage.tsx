import React from 'react';
import { useParams } from 'react-router-dom';
import { Thread } from '../../components/assistant-ui/thread.aui';
import { Composer } from '../../components/assistant-ui/composer.aui';
import { ChatHeader } from './ChatHeader';
import { RunStatusBar } from './RunStatusBar';
import { Recommendations } from './Recommendations';
import { InterruptHandler } from '../../agent/interrupts';
import { useFlatThreadList } from '../threads/threadQueries';
import { useLmaStream } from '../../agent/runtime';

export interface ChatPageProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onOpenMobileSidebar?: () => void;
}

export const ChatPage: React.FC<ChatPageProps> = ({
  isSidebarCollapsed = false,
  onToggleSidebar,
  onOpenMobileSidebar,
}) => {
  const { threadId } = useParams<{ threadId?: string }>();
  const { sessions } = useFlatThreadList();
  const stream = useLmaStream();

  const currentSession = sessions.find((s) => s.thread_id === threadId);
  const title = currentSession?.name || (threadId ? '监测分析会话' : '新监测分析会话');

  const isUnavailable = Boolean(
    stream?.error &&
    typeof stream.error === 'object' &&
    (('status' in (stream.error as any) && (stream.error as any).status >= 500) ||
     ('code' in (stream.error as any) && String((stream.error as any).code).includes('ECONN')))
  );

  return (
    <div className="flex flex-col h-full w-full bg-white relative overflow-hidden">
      {/* 顶部标题栏 */}
      <ChatHeader
        title={title}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onOpenMobileSidebar={onOpenMobileSidebar}
        connectionStatus={isUnavailable ? 'unavailable' : 'connected'}
      />

      {/* 主对话区 */}
      <div className="flex-1 min-h-0 relative">
        <Thread>
          {/* HITL 人机中断交互 */}
          <InterruptHandler />
        </Thread>
      </div>

      {/* 底部输入与状态栏 */}
      <div className="border-t border-neutral-100 bg-white/95 px-4 pb-4 pt-1.5 shrink-0 z-10">
        <div className="max-w-4xl mx-auto space-y-1.5">
          <Recommendations />
          <RunStatusBar />
          <Composer />
        </div>
      </div>
    </div>
  );
};
