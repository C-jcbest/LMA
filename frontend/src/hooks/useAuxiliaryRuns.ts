import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import { ThreadSession } from '../services/api';
import type { SidebarSession } from '../components/Sidebar';

interface UseAuxiliaryRunsOptions {
  client: Client;
  currentClientRef: React.MutableRefObject<Client>;
  sessionRequestRef: React.MutableRefObject<number>;
  sessions: ThreadSession[];
  setSessions: React.Dispatch<React.SetStateAction<ThreadSession[]>>;
  loadSessions: () => Promise<void>;
  selectThread: (id: string | null, mode?: 'push' | 'replace') => void;
}

/**
 * 3.3: 标题生命周期移至后端
 * 前端移除辅助 title runs、ownership check 与多重 ref。
 * 仅保留轻量级侧边栏新建骨架与导航同步，权威 metadata 由 loadSessions() 从服务端同步。
 */
export function useAuxiliaryRuns({
  client,
  currentClientRef,
  sessions,
  loadSessions,
  selectThread,
}: UseAuxiliaryRunsOptions) {
  const [titleViews, setTitleViews] = useState<Record<string, 'pending'>>({});
  const [newThreadOrder, setNewThreadOrder] = useState<string[]>([]);

  // 兼容性 ref 保留，不再触发前端 title run
  const titleJobsRef = useRef(new Map<string, any>());
  const activeSubmissionRef = useRef<{ client: Client; threadId: string | null } | null>(null);
  const firstInputRef = useRef<{ text: string; client: Client } | null>(null);

  const clearTitleView = useCallback((id: string) => {
    setTitleViews((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const onThreadId = useCallback(
    (id: string) => {
      if (currentClientRef.current !== client) return;
      selectThread(id, 'replace');
      setNewThreadOrder((ids) => [id, ...ids.filter((item) => item !== id)]);
      setTitleViews((current) => ({ ...current, [id]: 'pending' }));
    },
    [selectThread, client, currentClientRef]
  );

  const onCreated = useCallback(
    ({ runId: _runId }: { runId: string }) => {
      // 标题已移交后端在首轮结束时自动生成并更新 metadata
      // 前端无需创建额外 run，仅在适当时机刷新会话列表
      void loadSessions();
    },
    [loadSessions]
  );

  const sidebarSessions = useMemo<SidebarSession[]>(() => {
    const items: SidebarSession[] = sessions.map((session) => ({ ...session }));
    for (const [id, phase] of Object.entries(titleViews)) {
      const index = items.findIndex((session) => session.thread_id === id);
      const isPending = phase === 'pending' && (!items[index] || !items[index].name);
      const display: SidebarSession = {
        ...(index >= 0 ? items[index] : { thread_id: id }),
        name: isPending ? '' : items[index]?.name || '新会话',
        titlePending: isPending,
      };
      if (index >= 0) items[index] = display;
      else items.unshift(display);
    }
    const order = new Map(
      newThreadOrder.filter((id) => titleViews[id]).map((id, index) => [id, index])
    );
    return items.sort(
      (a, b) =>
        (order.get(a.thread_id) ?? newThreadOrder.length) -
        (order.get(b.thread_id) ?? newThreadOrder.length)
    );
  }, [sessions, titleViews, newThreadOrder]);

  return {
    titleViews,
    setTitleViews,
    newThreadOrder,
    setNewThreadOrder,
    titleJobsRef,
    activeSubmissionRef,
    firstInputRef,
    clearTitleView,
    onThreadId,
    onCreated,
    sidebarSessions,
  };
}
