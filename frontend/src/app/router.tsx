import React, { useState, useCallback } from 'react';
import {
  createBrowserRouter,
  Navigate,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ThreadSidebar } from '../features/threads/ThreadSidebar';
import { ChatPage } from '../features/chat/ChatPage';
import { LmaRuntimeProvider } from '../agent/runtime';
import { threadKeys } from '../features/threads/threadQueries';
import { Sheet, SheetContent } from '../components/ui/sheet';

export const ChatLayout: React.FC = () => {
  const { threadId } = useParams<{ threadId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const handleThreadIdChange = useCallback(
    (newThreadId: string | undefined) => {
      if (newThreadId && newThreadId !== threadId) {
        navigate(`/chat/${newThreadId}`, { replace: true });
        queryClient.invalidateQueries({ queryKey: threadKeys.all });
      }
    },
    [threadId, navigate, queryClient]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-neutral-900">
      {/* 桌面端常驻侧边栏 */}
      <ThreadSidebar className="hidden md:flex shrink-0" />

      {/* 移动端侧边抽屉 */}
      <Sheet open={isMobileSidebarOpen} onOpenChange={setIsMobileSidebarOpen}>
        <SheetContent side="left" className="p-0 w-72 max-w-[85vw]">
          <ThreadSidebar onItemSelect={() => setIsMobileSidebarOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* 主对话区 */}
      <main className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
        <LmaRuntimeProvider
          threadId={threadId}
          onThreadIdChange={handleThreadIdChange}
        >
          <ChatPage onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)} />
        </LmaRuntimeProvider>
      </main>
    </div>
  );
};

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/chat" replace />,
  },
  {
    path: '/chat',
    element: <ChatLayout />,
  },
  {
    path: '/chat/:threadId',
    element: <ChatLayout />,
  },
  {
    path: '*',
    element: <Navigate to="/chat" replace />,
  },
]);
