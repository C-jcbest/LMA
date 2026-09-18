import { useCallback, useEffect, useRef, useState } from 'react';

interface UseThreadNavigationOptions {
  onNavigate?: (nextThreadId: string | null) => void;
}

export function useThreadNavigation(options?: UseThreadNavigationOptions) {
  const onNavigate = options?.onNavigate;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // URL 仅记录选择态；消息和运行状态始终由官方 SDK 恢复。
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => new URL(window.location.href).searchParams.get('threadId')
  );
  const selectedThreadRef = useRef(activeThreadId);
  selectedThreadRef.current = activeThreadId;

  const isNewSessionDraft = activeThreadId === null;

  const selectThread = useCallback((id: string | null, mode: 'push' | 'replace' = 'push') => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('threadId') === id) return;
    if (id) url.searchParams.set('threadId', id);
    else url.searchParams.delete('threadId');

    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);

    selectedThreadRef.current = id;
    setActiveThreadId(id);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get('threadId');
      if (selectedThreadRef.current === id) return;
      // 导航只断开订阅，服务端 Run 继续；历史由 SDK 根据 URL ID 恢复。
      onNavigateRef.current?.(id);
      selectedThreadRef.current = id;
      setActiveThreadId(id);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return {
    activeThreadId,
    setActiveThreadId,
    selectedThreadRef,
    isNewSessionDraft,
    selectThread,
  };
}
