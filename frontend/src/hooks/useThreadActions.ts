import React, { useRef, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import type { AnyStream } from '@langchain/react';
import { ThreadSession, renameSession } from '../services/api';

interface UseThreadActionsOptions {
  client: Client;
  currentClientRef: React.MutableRefObject<Client>;
  selectedThreadRef: React.MutableRefObject<string | null>;
  sessionRequestRef: React.MutableRefObject<number>;
  deletingThreadsRef: React.MutableRefObject<Set<string>>;
  titleJobsRef: React.MutableRefObject<Map<string, any>>;
  setSessions: React.Dispatch<React.SetStateAction<ThreadSession[]>>;
  setNewThreadOrder: React.Dispatch<React.SetStateAction<string[]>>;
  clearTitleView: (id: string) => void;
  loadSessions: () => Promise<void>;
  selectThread: (id: string | null, mode?: 'push' | 'replace') => void;
  showToast: (message: string, type?: 'error' | 'warning' | 'info') => void;
}

export function useThreadActions({
  client,
  currentClientRef,
  selectedThreadRef,
  sessionRequestRef,
  deletingThreadsRef,
  titleJobsRef,
  setSessions,
  setNewThreadOrder,
  clearTitleView,
  loadSessions,
  selectThread,
  showToast,
}: UseThreadActionsOptions) {
  const [deletingThreadIds, setDeletingThreadIds] = useState<string[]>([]);

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      await renameSession(client, sessionId, newName);
      if (currentClientRef.current !== client) return;
      setSessions((current) =>
        current.map((session) =>
          session.thread_id === sessionId ? { ...session, name: newName } : session
        )
      );
      void loadSessions();
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('rename session error:', error);
      showToast('重命名失败，请稍后重试', 'error');
    }
  };

  const handleDeleteSession = async (sessionId: string, stream: AnyStream) => {
    // 同步防重，并作废删除之前的列表请求；DELETE 未确认时暂停轮询写回。
    if (deletingThreadsRef.current.has(sessionId)) return;
    deletingThreadsRef.current.add(sessionId);
    setDeletingThreadIds([...deletingThreadsRef.current]);
    ++sessionRequestRef.current;
    let stage = 'disconnect';
    console.info('delete session started:', { threadId: sessionId });
    try {
      // 删除前先断开此 Thread 的订阅，避免删除后取消/查询已不存在的会话。
      if (selectedThreadRef.current === sessionId) await stream.disconnect();
      stage = 'delete';
      await stream.client.threads.delete(sessionId);
      if (currentClientRef.current !== client) return;
      console.info('delete session confirmed:', { threadId: sessionId });
      stage = 'display';
      ++sessionRequestRef.current;
      setNewThreadOrder((ids) => ids.filter((id) => id !== sessionId));
      clearTitleView(sessionId);
      titleJobsRef.current.delete(sessionId);
      setSessions((current) => current.filter((session) => session.thread_id !== sessionId));
      if (selectedThreadRef.current === sessionId) selectThread(null, 'replace');
    } catch (error) {
      if (currentClientRef.current !== client) return;
      console.warn('delete session error:', error);
      const status =
        error && typeof error === 'object' && 'status' in error
          ? (error as any).status
          : undefined;
      console.warn('delete session failed stage:', { threadId: sessionId, stage, status });
      showToast(
        status === 404
          ? '此会话已不存在'
          : status === 409
          ? '会话正在运行，请停止后再删除'
          : '删除失败，请稍后重试',
        'error'
      );
    } finally {
      if (currentClientRef.current === client) {
        deletingThreadsRef.current.delete(sessionId);
        setDeletingThreadIds([...deletingThreadsRef.current]);
        void loadSessions();
      }
    }
  };

  return {
    deletingThreadIds,
    handleRenameSession,
    handleDeleteSession,
  };
}
