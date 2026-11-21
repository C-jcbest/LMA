import { useEffect, useRef, useSyncExternalStore } from 'react';


const STORAGE_KEY = 'lma-unread-sessions';
const SYSTEM_NOTICE_KEY = 'lma-run-notifications';
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

export const systemNoticeSupported = () => typeof window !== 'undefined' && 'Notification' in window;

function readSystemNoticeEnabled() {
  try {
    return window.localStorage.getItem(SYSTEM_NOTICE_KEY) === 'on';
  } catch {
    return false;
  }
}

let systemNoticeEnabled = typeof window !== 'undefined' && readSystemNoticeEnabled();

export const useSystemNoticeEnabled = () => useSyncExternalStore(subscribe, () => systemNoticeEnabled);

export async function setSystemNoticeEnabled(enabled: boolean) {
  let next = enabled;
  if (enabled && Notification.permission !== 'granted') {
    next = (await Notification.requestPermission()) === 'granted';
  }
  systemNoticeEnabled = next;
  try {
    window.localStorage.setItem(SYSTEM_NOTICE_KEY, next ? 'on' : 'off');
  } catch {
  }
  for (const listener of listeners) {
    listener();
  }
}

function showSystemNotice(title: string | undefined) {
  if (!systemNoticeEnabled || !systemNoticeSupported() || Notification.permission !== 'granted') {
    return;
  }
  const notice = new Notification('调查已完成', { body: title || '新会话', tag: 'lma-run-complete' });
  notice.onclick = () => {
    window.focus();
    notice.close();
  };
}

export const useIsSessionUnread = (sessionId: string | undefined) =>
  useSyncExternalStore(subscribe, () => (sessionId ? unread.has(sessionId) : false));

export function useRunCompletionNotice(sessionId: string | undefined, isRunning: boolean, isOpen: boolean, title?: string) {
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
      showSystemNotice(title);
    }
  }, [isRunning, isOpen, sessionId, title]);

  useEffect(() => {
    if (isOpen && sessionId && unread.has(sessionId) && !document.hidden) {
      const next = new Set(unread);
      next.delete(sessionId);
      writeUnread(next);
    }
  }, [isOpen, sessionId]);
}
