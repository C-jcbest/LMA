import React, { useState, useEffect, useRef } from 'react';
import {
  Mountain,
  Plus,
  MessageSquare,
  Trash2,
  Edit2,
  Check,
  X,
  PanelLeftClose,
  User,
  Settings,
  Server,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { ThreadSession } from '../services/api';

interface SidebarProps {
  sessions: ThreadSession[];
  activeSessionId: string | null;
  isNewSessionDraft: boolean;
  /** 正在生成回复的会话 thread_id 列表 */
  generatingThreadIds: string[];
  onSelectSession: (session: ThreadSession) => void;
  onCreateSession: () => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onToggleCollapse: () => void;
  onOpenConfig: () => void;
  isLiveServer: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  isNewSessionDraft,
  generatingThreadIds,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onToggleCollapse,
  onOpenConfig,
  isLiveServer,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleStartRename = (e: React.MouseEvent, session: ThreadSession) => {
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

  const handleDelete = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onDeleteSession(sessionId);
  };

  return (
    <div className="w-[260px] h-full flex flex-col bg-[#fafafa] border-r border-neutral-200/80 text-neutral-700 select-none shrink-0 transition-all">
      {/* 顶部 Header: Logo + 标题 + 折叠按钮 */}
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-black flex items-center justify-center shadow-sm shrink-0">
            <Mountain className="w-4 h-4 text-white stroke-[2.2]" />
          </div>
          <span className="font-bold text-sm tracking-tight text-neutral-900 truncate">
            LMA Monitor
          </span>
          {isLiveServer ? (
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="LangGraph 服务已连接" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="未连接后端服务" />
          )}
        </div>
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/60 transition-colors"
          title="收起侧边栏"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* 新建会话按钮 */}
      <div className="px-3 pt-1 pb-3">
        <button
          onClick={onCreateSession}
          className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 hover:border-neutral-300 text-neutral-800 text-xs font-medium flex items-center justify-center gap-2 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.03)] active:scale-[0.98]"
        >
          <Plus className="w-4 h-4 text-neutral-500" />
          <span>新建监测会话</span>
        </button>
      </div>

      {/* 历史会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {sessions.length === 0 && !isNewSessionDraft ? (
          <div className="h-36 flex flex-col items-center justify-center text-neutral-400 text-xs px-4 text-center select-none">
            <MessageSquare className="w-7 h-7 mb-2 opacity-30 text-neutral-500" />
            暂无历史监测会话<br />点击上方新建开始监测
          </div>
        ) : (
          sessions.map((session) => {
            if (session.isGeneratingTitle) {
              return (
                <div
                  key={session.thread_id}
                  className="flex items-center gap-2.5 h-9 px-3 rounded-xl border border-neutral-200/90 bg-neutral-100 animate-pulse select-none"
                >
                  <MessageSquare className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                  <div className="h-2.5 bg-neutral-200 rounded w-20"></div>
                </div>
              );
            }

            const isActive = !isNewSessionDraft && session.thread_id === activeSessionId;
            const isEditing = editingId === session.thread_id;
            const isGenerating = generatingThreadIds.includes(session.thread_id);

          return (
            <div
              key={session.thread_id}
              onClick={() => !isEditing && onSelectSession(session)}
              className={`group relative flex items-center justify-between h-9 px-3 rounded-xl text-xs cursor-pointer transition-colors ${
                isActive
                  ? 'bg-neutral-200/75 text-neutral-900 font-medium'
                  : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                {isGenerating ? (
                  <span title="正在生成回复" className="shrink-0 flex">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                  </span>
                ) : (
                  <MessageSquare
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? 'text-neutral-800' : 'text-neutral-400 group-hover:text-neutral-600'
                    }`}
                  />
                )}
                {isEditing ? (
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

              {/* 悬停操作按钮：生成中时替换为 loading 图标，不可重命名/删除 */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {isEditing ? (
                  <>
                    <button
                      onClick={(e) => handleSaveRename(e, session.thread_id)}
                      className="p-1 hover:text-emerald-600"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button onClick={handleCancelRename} className="p-1 hover:text-neutral-500">
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : isGenerating ? (
                  <span title="生成中，暂不可重命名或删除" className="p-1 flex">
                    <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />
                  </span>
                ) : (
                  <>
                    <button
                      onClick={(e) => handleStartRename(e, session)}
                      className="p-1 text-neutral-400 hover:text-neutral-700"
                      title="重命名"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, session.thread_id)}
                      className="p-1 text-neutral-400 hover:text-red-600"
                      title="删除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        }))}
      </div>

      {/* 底部用户卡片 */}
      <div className="p-3 border-t border-neutral-200/80 relative" ref={menuRef}>
        {showUserMenu && (
          <div className="absolute bottom-16 left-3 right-3 bg-white border border-neutral-200 rounded-xl shadow-lg p-1.5 z-50 text-xs space-y-1">
            <button
              onClick={() => {
                setShowUserMenu(false);
                onOpenConfig();
              }}
              className="w-full px-3 py-2 rounded-lg text-left flex items-center gap-2 hover:bg-neutral-50 text-neutral-700"
            >
              <Server className="w-3.5 h-3.5 text-neutral-500" />
              <span>LangGraph 服务配置</span>
            </button>
            <div className="h-px bg-neutral-100 my-1" />
            <div className="px-3 py-1.5 text-[11px] text-neutral-400">
              当前状态: {isLiveServer ? '已连接后端 (2024)' : '未连接后端服务'}
            </div>
          </div>
        )}

        <div
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-neutral-200/50 cursor-pointer transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-neutral-200/70 border border-neutral-300 flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-neutral-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-neutral-800 truncate">admin</div>
            <div className="text-[10px] text-neutral-400 truncate">监测中心用户</div>
          </div>
        </div>
      </div>
    </div>
  );
};
