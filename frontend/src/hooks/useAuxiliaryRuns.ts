import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import {
  ThreadSession,
  generateSessionTitle,
  projectThreadSessions,
  mergeSessions,
} from '../services/api';
import type { SidebarSession } from '../components/Sidebar';

interface TitleJob {
  text: string;
  client: Client;
  creationNotified: boolean;
  titleStarted?: boolean;
}

interface UseAuxiliaryRunsOptions {
  client: Client;
  currentClientRef: React.MutableRefObject<Client>;
  sessionRequestRef: React.MutableRefObject<number>;
  sessions: ThreadSession[];
  setSessions: React.Dispatch<React.SetStateAction<ThreadSession[]>>;
  loadSessions: () => Promise<void>;
  selectThread: (id: string | null, mode?: 'push' | 'replace') => void;
}

export function useAuxiliaryRuns({
  client,
  currentClientRef,
  sessionRequestRef,
  sessions,
  setSessions,
  loadSessions,
  selectThread,
}: UseAuxiliaryRunsOptions) {
  // 仅保存标题展示任务；不预创建 Thread，不复制权威消息历史。
  const [titleViews, setTitleViews] = useState<Record<string, 'pending'>>({});
  const [newThreadOrder, setNewThreadOrder] = useState<string[]>([]);

  const titleJobsRef = useRef(new Map<string, TitleJob>());
  const activeSubmissionRef = useRef<{
    client: Client;
    threadId: string | null;
  } | null>(null);
  const firstInputRef = useRef<{ text: string; client: Client } | null>(null);

  const clearTitleView = useCallback((id: string) => {
    setTitleViews((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const onThreadId = useCallback(
    (id: string) => {
      if (currentClientRef.current !== client) return;
      selectThread(id, 'replace');
      if (activeSubmissionRef.current?.client === client) activeSubmissionRef.current.threadId = id;
      const input = firstInputRef.current;
      if (input) {
        setNewThreadOrder((ids) => [id, ...ids.filter((item) => item !== id)]);
        titleJobsRef.current.set(id, { ...input, creationNotified: false });
        setTitleViews((current) => ({ ...current, [id]: 'pending' }));
      }
    },
    [selectThread, client, currentClientRef]
  );

  const onCreated = useCallback(
    ({ runId }: { runId: string }) => {
      // 官方回调只有 runId。用服务端 Run 确认归属，迟到回调和切换会话不会串标题。
      for (const [id, job] of titleJobsRef.current) {
        job.creationNotified = true;
        void (async () => {
          try {
            await job.client.runs.get(id, runId);
          } catch (error) {
            job.creationNotified = false;
            console.warn('title run ownership check error:', error);
            return;
          }
          if (titleJobsRef.current.get(id) !== job || job.titleStarted) return;
          job.titleStarted = true;
          // 在 Run 已被接受时开始，绝不等待主 Agent 完成。
          const titlePromise = generateSessionTitle(job.client, job.text).catch((error) => {
            console.warn('generate session title error:', error);
            return '新会话';
          });
          try {
            const title = await titlePromise;
            if (titleJobsRef.current.get(id) !== job) return;
            const current = await job.client.threads.get(id);
            if (titleJobsRef.current.get(id) !== job) return;
            // 只更新尚未命名的会话，保留服务端已确认的手动命名。
            const thread = current.metadata?.name
              ? current
              : await job.client.threads.update(id, { metadata: { name: title } });
            if (titleJobsRef.current.get(id) !== job) return;
            const confirmed = projectThreadSessions([thread]);
            ++sessionRequestRef.current;
            setSessions((items) => mergeSessions(items, confirmed));
            clearTitleView(id);
            void loadSessions();
          } catch (error) {
            // 辅助能力静默降级：记录日志，清掉 title skeleton，由 loadSessions() 从权威服务端列表同步，绝不伪造 created_at
            console.warn('session title metadata save error:', error);
            if (titleJobsRef.current.get(id) === job) {
              clearTitleView(id);
              void loadSessions();
            }
          } finally {
            if (titleJobsRef.current.get(id) === job) titleJobsRef.current.delete(id);
          }
        })();
      }
    },
    [clearTitleView, loadSessions, sessionRequestRef, setSessions]
  );

  const sidebarSessions = useMemo<SidebarSession[]>(() => {
    const items: SidebarSession[] = sessions.map((session) => ({ ...session }));
    for (const [id, phase] of Object.entries(titleViews)) {
      const index = items.findIndex((session) => session.thread_id === id);
      const display = {
        ...(index >= 0 ? items[index] : { thread_id: id }),
        name: phase === 'pending' ? '' : items[index]?.name || '新会话',
        titlePending: phase === 'pending',
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
