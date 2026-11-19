import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 调查在后台完成时的提醒：用户不在这条会话或页面不可见时，会话标题加粗表示未读，
 * 浏览器标签标题前加完成数量。未读记录只存在本机浏览器，是个人便利，不进数据库。
 */

const STORAGE_KEY = 'lma-unread-sessions';
const listeners = new Set<() => void>();
let unread = readUnread();
let baseTitle: string | null = null;
let finishedWhileHidden = 0;

function readUnread(): ReadonlySet<string> {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return new Set(stored ? (JSON.parse(stored) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeUnread(next: ReadonlySet<string>) {
  unread = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // 浏览器禁止本地存储时只在本页内记住。
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function showFinishedInTitle() {
  baseTitle ??= document.title;
  finishedWhileHidden += 1;
  document.title = `（${finishedWhileHidden}）${baseTitle}`;
}

function restoreTitle() {
  if (baseTitle === null) {
    return;
  }
  document.title = baseTitle;
  baseTitle = null;
  finishedWhileHidden = 0;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      restoreTitle();
    }
  });
}

export const useIsSessionUnread = (sessionId: string | undefined) =>
  useSyncExternalStore(subscribe, () => (sessionId ? unread.has(sessionId) : false));

/**
 * 在会话列表的每一行调用：运行中变为结束时，若用户正看着别的会话或页面在后台，就记为未读并提示；
 * 打开这条会话即清除未读。
 */
export function useRunCompletionNotice(sessionId: string | undefined, isRunning: boolean, isOpen: boolean) {
  const wasRunning = useRef(isRunning);

  useEffect(() => {
    const finished = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!finished || !sessionId) {
      return;
    }
    if (document.hidden) {
      showFinishedInTitle();
    }
    if (!isOpen || document.hidden) {
      writeUnread(new Set([...unread, sessionId]));
    }
  }, [isRunning, isOpen, sessionId]);

  useEffect(() => {
    if (isOpen && sessionId && unread.has(sessionId) && !document.hidden) {
      const next = new Set(unread);
      next.delete(sessionId);
      writeUnread(next);
    }
  }, [isOpen, sessionId]);
}
