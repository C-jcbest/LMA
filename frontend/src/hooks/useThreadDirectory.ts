import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '@langchain/langgraph-sdk';
import {
  ThreadSession,
  getSessions,
  getBusySessions,
  mergeSessions,
} from '../services/api';

interface UseThreadDirectoryOptions {
  client: Client;
  currentClientRef: React.MutableRefObject<Client>;
  deletingThreadsRef: React.MutableRefObject<Set<string>>;
}

export function useThreadDirectory({
  client,
  currentClientRef,
  deletingThreadsRef,
}: UseThreadDirectoryOptions) {
  const [sessions, setSessions] = useState<ThreadSession[]>([]);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isListLoading, setIsListLoading] = useState(false);
  const [listError, setListError] = useState('');

  const nextOffsetRef = useRef(0);
  const listPendingRef = useRef(false);
  const sessionRequestRef = useRef(0);

  const loadSessions = useCallback(async (append = false) => {
    if (currentClientRef.current !== client || deletingThreadsRef.current.size) return;
    if (append && listPendingRef.current) return;
    listPendingRef.current = true;
    setIsListLoading(true);
    setListError('');
    const request = ++sessionRequestRef.current;
    try {
      // 事件刷新重新获取已加载范围，避免删除/更新后 offset 位移；空闲时不轮询全列表。
      let res = await getSessions(client, append ? nextOffsetRef.current : 0);
      let rows = res.sessions;
      const loadedEnd = nextOffsetRef.current;
      while (!append && res.hasMore && res.nextOffset < loadedEnd) {
        res = await getSessions(client, res.nextOffset);
        rows = mergeSessions(rows, res.sessions);
      }
      if (request !== sessionRequestRef.current) return;
      setSessions((current) => mergeSessions(append ? current : [], rows));
      nextOffsetRef.current = res.nextOffset;
      setHasMoreSessions(res.hasMore);
    } catch (error) {
      if (request !== sessionRequestRef.current) return;
      console.warn('loadSessions err:', error);
      setListError('会话列表加载失败，请重试');
    } finally {
      if (request === sessionRequestRef.current) {
        listPendingRef.current = false;
        setIsListLoading(false);
      }
    }
  }, [client, currentClientRef, deletingThreadsRef]);

  useEffect(() => {
    void loadSessions();
    return () => {
      ++sessionRequestRef.current;
    };
  }, [loadSessions]);

  const busyIds = sessions
    .filter((item) => item.status === 'busy')
    .map((item) => item.thread_id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!busyIds) return;
    let disposed = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending || deletingThreadsRef.current.size || listPendingRef.current) return;
      pending = true;
      const request = sessionRequestRef.current;
      void getBusySessions(client, busyIds.split(','))
        .then((rows) => {
          if (disposed || request !== sessionRequestRef.current || currentClientRef.current !== client) return;
          setSessions((current) => mergeSessions(current, rows));
          setListError('');
        })
        .catch((error) => {
          if (disposed || request !== sessionRequestRef.current) return;
          console.warn('busy session refresh error:', error);
          setListError('会话状态刷新失败，请重试');
        })
        .finally(() => {
          pending = false;
        });
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [client, busyIds, currentClientRef, deletingThreadsRef]);

  return {
    sessions,
    setSessions,
    hasMoreSessions,
    setHasMoreSessions,
    isListLoading,
    setIsListLoading,
    listError,
    setListError,
    loadSessions,
    nextOffsetRef,
    listPendingRef,
    sessionRequestRef,
  };
}
