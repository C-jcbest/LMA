import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 调查在后台完成时的提醒：用户不在这条会话或页面不可见时，会话标题加粗表示未读，
 * 浏览器标签标题前加完成数量。未读记录只存在本机浏览器，是个人便利，不进数据库。
 */

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

/** 浏览器是否支持系统通知；是否开启由导航底部的开关决定，只记在本机。 */
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

/** 打开时先请求浏览器授权；用户拒绝则保持关闭。 */
export async function setSystemNoticeEnabled(enabled: boolean) {
  let next = enabled;
  if (enabled && Notification.permission !== 'granted') {
    next = (await Notification.requestPermission()) === 'granted';
  }
  systemNoticeEnabled = next;
  try {
    window.localStorage.setItem(SYSTEM_NOTICE_KEY, next ? 'on' : 'off');
  } catch {
    // 浏览器禁止本地存储时只在本页内记住。
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

/**
 * 在会话列表的每一行调用：运行中变为结束时，若用户正看着别的会话或页面在后台，就记为未读并提示；
 * 打开这条会话即清除未读。
 */
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
