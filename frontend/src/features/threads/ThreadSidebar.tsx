import React, { useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  Plus,
  Search,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Skeleton } from '../../components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { useFlatThreadList } from './threadQueries';
import { useRenameThreadMutation, useDeleteThreadMutation } from './threadMutations';
import { formatTime } from '../../lib/datetime';

export interface ThreadSidebarProps {
  onItemSelect?: () => void;
  className?: string;
}

export const ThreadSidebar: React.FC<ThreadSidebarProps> = ({
  onItemSelect,
  className = '',
}) => {
  const navigate = useNavigate();
  const { threadId: activeThreadId } = useParams<{ threadId?: string }>();

  const { sessions, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useFlatThreadList();
  const renameMutation = useRenameThreadMutation();
  const deleteMutation = useDeleteThreadMutation();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingThread, setEditingThread] = useState<{ id: string; name: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);

  // 过滤后的列表
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase().trim();
    return sessions.filter(
      (s) => s.name.toLowerCase().includes(q) || s.thread_id.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  const handleSelectThread = (threadId: string) => {
    navigate(`/chat/${threadId}`);
    onItemSelect?.();
  };

  const handleNewChat = () => {
    navigate('/chat');
    onItemSelect?.();
  };

  const openRenameDialog = (threadId: string, currentName: string) => {
    setEditingThread({ id: threadId, name: currentName });
    setRenameInput(currentName);
  };

  const handleConfirmRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingThread || !renameInput.trim()) return;
    await renameMutation.mutateAsync({
      threadId: editingThread.id,
      newName: renameInput.trim(),
    });
    setEditingThread(null);
  };

  const handleConfirmDelete = async () => {
    if (!deletingThreadId) return;
    const targetId = deletingThreadId;
    await deleteMutation.mutateAsync({ threadId: targetId });
    setDeletingThreadId(null);
    if (activeThreadId === targetId) {
      navigate('/chat');
    }
  };

  return (
    <aside
      className={`flex flex-col h-full w-64 bg-neutral-50/90 border-r border-neutral-200 select-none ${className}`}
    >
      {/* 侧边栏头部 */}
      <div className="p-3 border-b border-neutral-200/80 space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-indigo-600 text-white flex items-center justify-center shadow-2xs">
              <Activity className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-semibold text-neutral-800 tracking-tight">
              LMA 滑坡连续监测
            </span>
          </div>
        </div>

        <Button
          type="button"
          onClick={handleNewChat}
          className="w-full justify-start gap-2 bg-white hover:bg-neutral-100 text-neutral-800 border border-neutral-200/80 shadow-2xs text-xs font-medium h-8.5 rounded-lg transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5 text-indigo-600" />
          <span>新建监测分析</span>
        </Button>

        {/* 搜索框 */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话…"
            className="pl-8 h-7.5 text-xs bg-neutral-100/70 border-neutral-200 placeholder:text-neutral-400 rounded-md focus-visible:ring-1 focus-visible:ring-indigo-500"
          />
        </div>
      </div>

      {/* 会话列表区域 */}
      <ScrollArea className="flex-1 px-2 py-2">
        {isLoading ? (
          <div className="space-y-2 p-1">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="py-8 text-center text-xs text-neutral-400">
            {searchQuery ? '未找到匹配会话' : '暂无历史监测会话'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredSessions.map((session) => {
              const isActive = activeThreadId === session.thread_id;
              return (
                <div
                  key={session.thread_id}
                  className={`group relative flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-neutral-200/80 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
                  }`}
                  onClick={() => handleSelectThread(session.thread_id)}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 pr-2">
                    <MessageSquare
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isActive ? 'text-indigo-600' : 'text-neutral-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs">{session.name}</div>
                      <div className="text-[10px] text-neutral-400 truncate">
                        {formatTime(session.updated_at || session.created_at)}
                      </div>
                    </div>
                  </div>

                  {/* 会话操作下拉菜单 */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="会话操作"
                          className="h-6 w-6 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/60"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-32 text-xs">
                        <DropdownMenuItem
                          onClick={() => openRenameDialog(session.thread_id, session.name)}
                          className="gap-2 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>重命名</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeletingThreadId(session.thread_id)}
                          className="gap-2 text-red-600 focus:text-red-600 focus:bg-red-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}

            {hasNextPage && (
              <div className="pt-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isFetchingNextPage}
                  onClick={() => fetchNextPage()}
                  className="w-full text-xs text-neutral-500 hover:text-neutral-800"
                >
                  {isFetchingNextPage ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    '加载更多会话'
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* 底部信息 */}
      <div className="p-3 border-t border-neutral-200/80 text-[11px] text-neutral-400 flex items-center justify-between">
        <span>LMA Runtime V2</span>
        <span className="font-mono">Asia/Shanghai</span>
      </div>

      {/* 重命名 Dialog */}
      <Dialog
        open={Boolean(editingThread)}
        onOpenChange={(open) => !open && setEditingThread(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <form onSubmit={handleConfirmRename}>
            <DialogHeader>
              <DialogTitle className="text-sm font-semibold">修改会话名称</DialogTitle>
            </DialogHeader>
            <div className="py-3">
              <Input
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                placeholder="请输入新会话名称"
                autoFocus
                className="text-xs"
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditingThread(null)}
                className="text-xs"
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={renameMutation.isPending || !renameInput.trim()}
                className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {renameMutation.isPending ? '保存中…' : '确认'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认 AlertDialog */}
      <AlertDialog
        open={Boolean(deletingThreadId)}
        onOpenChange={(open) => !open && setDeletingThreadId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm font-semibold">确认删除此会话？</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-neutral-500">
              删除后该会话的所有监测分析记录将不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="text-xs bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
};
