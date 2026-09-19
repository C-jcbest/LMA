import React, { useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Mountain,
  Plus,
  MessageSquare,
  Trash2,
  Edit2,
  Check,
  X,
  PanelLeftClose,
  Server,
  Loader2,
} from 'lucide-react';

// SDK 已分配 ID 的骨架只含展示字段，不伪造服务端 created_at。
export interface SidebarSession {
  thread_id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  titlePending?: boolean;
}

interface SidebarProps {
  sessions: SidebarSession[];
  activeSessionId: string | null;
  isNewSessionDraft: boolean;
  /** Thread search busy 或当前官方 Run active 的 thread_id 列表 */
  busyThreadIds: string[];
  /** 实际 DELETE 请求尚未完成的会话，禁止重复操作。 */
  deletingThreadIds?: string[];
  onSelectSession: (session: Pick<SidebarSession, 'thread_id'>) => void;
  onCreateSession: () => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onToggleCollapse: () => void;
  onOpenConfig: () => void;
  hasMoreSessions?: boolean;
  isListLoading?: boolean;
  listError?: string;
  disabled?: boolean;
  onLoadMore?: () => void;
  onRefreshSessions?: () => void;
  onDismissListError?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  isNewSessionDraft,
  busyThreadIds,
  deletingThreadIds = [],
  disabled = false,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onToggleCollapse,
  onOpenConfig,
  hasMoreSessions = false,
  isListLoading = false,
  listError = '',
  onLoadMore,
  onRefreshSessions,
  onDismissListError,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [sessionToDelete, setSessionToDelete] = useState<SidebarSession | null>(null);

  const handleStartRename = (e: React.MouseEvent, session: SidebarSession) => {
    e.stopPropagation();
    setEditingId(session.thread_id);
    setEditValue(session.name);
  };

  const handleSaveRename = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (editValue.trim()) {
      onRenameSession(sessionId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleDeleteClick = (e: React.MouseEvent, session: SidebarSession) => {
    e.stopPropagation();
    setSessionToDelete(session);
  };

  const handleConfirmDelete = () => {
    if (sessionToDelete) {
      onDeleteSession(sessionToDelete.thread_id);
      setSessionToDelete(null);
    }
  };

  return (
    <div className="w-[260px] h-full flex flex-col bg-[#fafafa] border-r border-neutral-200/80 text-neutral-700 select-none shrink-0 transition-all">
      {/* 顶部 Header: Logo + 标题 + 折叠按钮 */}
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-black flex items-center justify-center shadow-xs shrink-0">
            <Mountain className="w-4 h-4 text-white stroke-[2.2]" />
          </div>
          <span className="font-bold text-sm tracking-tight text-neutral-900 truncate">
            LMA Monitor
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/60 transition-colors cursor-pointer"
          title="收起侧边栏"
          aria-label="收起侧边栏"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* 新建会话按钮 */}
      <div className="px-3 pt-1 pb-3">
        <button
          type="button"
          onClick={onCreateSession}
          disabled={disabled}
          className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 hover:border-neutral-300 text-neutral-800 text-xs font-medium flex items-center justify-center gap-2 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.03)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none cursor-pointer"
        >
          <Plus className="w-4 h-4 text-neutral-500" />
          <span>新建监测会话</span>
        </button>
      </div>

      {/* 历史会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {onRefreshSessions && (
          <button
            type="button"
            onClick={onRefreshSessions}
            disabled={disabled || isListLoading}
            className="w-full py-2 text-xs text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50 cursor-pointer"
          >
            刷新会话列表
          </button>
        )}
        {sessions.length === 0 && !isNewSessionDraft ? (
          <div className="h-36 flex flex-col items-center justify-center text-neutral-400 text-xs px-4 text-center select-none">
            <MessageSquare className="w-7 h-7 mb-2 opacity-30 text-neutral-500" />
            暂无历史监测会话<br />点击上方新建开始监测
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = !isNewSessionDraft && session.thread_id === activeSessionId;
            const isEditing = editingId === session.thread_id;
            const isBusy = busyThreadIds.includes(session.thread_id);
            const isDeleting = deletingThreadIds.includes(session.thread_id);

            return (
              <div
                key={session.thread_id}
                data-thread-id={session.thread_id}
                onClick={() => !disabled && !isEditing && onSelectSession(session)}
                className={`group relative flex items-center justify-between h-9 px-3 rounded-xl text-xs transition-colors ${
                  disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                } ${
                  isActive
                    ? 'bg-neutral-200/75 text-neutral-900 font-medium'
                    : disabled
                    ? 'text-neutral-400'
                    : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                  <MessageSquare
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? 'text-neutral-800' : 'text-neutral-400 group-hover:text-neutral-600'
                    }`}
                  />
                  {session.titlePending ? (
                    <span role="status" aria-label="会话标题生成中" className="h-2.5 bg-neutral-200 rounded-sm w-20 animate-pulse" />
                  ) : isEditing ? (
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full bg-white border border-neutral-300 rounded px-1.5 py-0.5 text-xs text-neutral-800 outline-none"
                      autoFocus
                    />
                  ) : (
                    <span className="truncate">{session.name}</span>
                  )}
                </div>

                {/* 悬停操作按钮 */}
                <div className={`flex items-center gap-1 transition-opacity ${isBusy || isDeleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={(e) => handleSaveRename(e, session.thread_id)}
                        className="p-1 hover:text-emerald-600 cursor-pointer"
                        title="确认"
                        aria-label="确认重命名"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRename}
                        className="p-1 hover:text-neutral-500 cursor-pointer"
                        title="取消"
                        aria-label="取消重命名"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  ) : isBusy || isDeleting ? (
                    <span title={isDeleting ? "删除中，暂不可重复操作" : "生成中，暂不可重命名或删除"} className="p-1 flex">
                      <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
                    </span>
                  ) : session.titlePending ? null : (
                    <>
                      <button
                        type="button"
                        onClick={(e) => handleStartRename(e, session)}
                        className="p-1 text-neutral-400 hover:text-neutral-700 cursor-pointer"
                        title="重命名"
                        aria-label="重命名会话"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteClick(e, session)}
                        className="p-1 text-neutral-400 hover:text-red-600 cursor-pointer"
                        title="删除"
                        aria-label="删除会话"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}

        {listError && (
          <div role="alert" className="mx-2 my-1.5 p-2 rounded-xl border border-amber-200 bg-amber-50/80 text-xs text-amber-900 flex items-center justify-between gap-1 shadow-xs">
            <span className="truncate">{listError}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {onRefreshSessions && (
                <button
                  type="button"
                  onClick={onRefreshSessions}
                  disabled={isListLoading}
                  className="underline hover:text-amber-950 transition-colors cursor-pointer"
                >
                  重试加载会话
                </button>
              )}
              {onDismissListError && (
                <button
                  type="button"
                  onClick={onDismissListError}
                  className="p-0.5 rounded hover:bg-amber-100/80 text-amber-700 hover:text-amber-950 transition-colors cursor-pointer"
                  title="关闭"
                  aria-label="关闭错误提示"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {isListLoading ? (
          <p role="status" className="py-2 text-center text-xs text-neutral-500">
            正在加载会话
          </p>
        ) : (
          hasMoreSessions && (
            <button
              type="button"
              onClick={onLoadMore}
              className="w-full py-2 text-xs text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer"
            >
              加载更多会话
            </button>
          )
        )}
      </div>

      {/* 底部用户卡片（改用 Radix DropdownMenu） */}
      <div className="p-3 border-t border-neutral-200/80">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <div
              role="button"
              tabIndex={0}
              className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-neutral-200/50 cursor-pointer transition-colors focus:outline-none"
            >
              <div className="w-8 h-8 rounded-full bg-neutral-200/70 border border-neutral-300 flex items-center justify-center shrink-0">
                <Server className="w-4 h-4 text-neutral-600" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-neutral-800 truncate">LMA 监测服务</div>
                <div className="text-[10px] text-neutral-400 truncate">系统与连接设置</div>
              </div>
            </div>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="top"
              sideOffset={8}
              className="w-56 bg-white border border-neutral-200 rounded-xl shadow-lg p-1.5 z-50 text-xs animate-in fade-in zoom-in-95 duration-100 focus:outline-none"
            >
              <DropdownMenu.Item
                onClick={onOpenConfig}
                className="w-full px-3 py-2 rounded-lg flex items-center gap-2 hover:bg-neutral-50 text-neutral-700 outline-none cursor-pointer"
              >
                <Server className="w-3.5 h-3.5 text-neutral-500" />
                <span>LangGraph 服务配置</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* 删除会话确认弹窗（改用 Radix AlertDialog） */}
      <AlertDialog.Root
        open={Boolean(sessionToDelete)}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 animate-in fade-in" />
          <AlertDialog.Content role="dialog" className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-neutral-200 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden p-5 text-neutral-800 z-50 animate-in zoom-in-95 duration-150 focus:outline-none">
            <div className="flex items-start gap-3.5">
              <div className="w-9 h-9 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center text-red-600 shrink-0">
                <Trash2 className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialog.Title className="text-sm font-semibold text-neutral-900">
                  删除会话
                </AlertDialog.Title>
                <AlertDialog.Description className="text-xs text-neutral-500 mt-1 leading-relaxed">
                  确定要删除会话
                  <span className="font-medium text-neutral-800 mx-1 break-all">
                    “{sessionToDelete?.name || '新监测调查'}”
                  </span>
                  吗？删除后该会话的全部监测分析历史将无法恢复。
                </AlertDialog.Description>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2.5">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="px-3.5 py-1.5 rounded-lg border border-neutral-200 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 transition-colors cursor-pointer"
                >
                  取消
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-xs font-medium text-white shadow-xs transition-colors cursor-pointer"
                >
                  确认删除
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
};
