import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useIsSessionUnread, useRunCompletionNotice } from '@/features/notifications/run-completion';

let pageHidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageHidden });

const setPageHidden = (hidden: boolean) => {
  pageHidden = hidden;
  document.dispatchEvent(new Event('visibilitychange'));
};

function useSessionRow(sessionId: string, isRunning: boolean, isOpen: boolean) {
  useRunCompletionNotice(sessionId, isRunning, isOpen);
  return useIsSessionUnread(sessionId);
}

describe('调查完成提醒', () => {
  afterEach(() => {
    setPageHidden(false);
  });

  it('看着别的会话时调查结束记为未读，打开这条会话后清除', () => {
    const { result, rerender } = renderHook(
      ({ running, open }) => useSessionRow('session-other', running, open),
      { initialProps: { running: true, open: false } },
    );
    expect(result.current).toBe(false);

    rerender({ running: false, open: false });
    expect(result.current).toBe(true);

    rerender({ running: false, open: true });
    expect(result.current).toBe(false);
  });

  it('正在看的会话在前台结束不算未读', () => {
    const { result, rerender } = renderHook(
      ({ running }) => useSessionRow('session-open', running, true),
      { initialProps: { running: true } },
    );
    rerender({ running: false });
    expect(result.current).toBe(false);
  });

  it('页面在后台时标签标题显示完成数量，回到页面恢复', () => {
    document.title = 'LMA Monitor';
    const { rerender } = renderHook(
      ({ running }) => useSessionRow('session-background', running, true),
      { initialProps: { running: true } },
    );
    setPageHidden(true);
    rerender({ running: false });
    expect(document.title).toBe('（1）LMA Monitor');

    act(() => setPageHidden(false));
    expect(document.title).toBe('LMA Monitor');
  });
});
