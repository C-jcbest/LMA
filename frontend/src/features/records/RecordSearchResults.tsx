import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAui } from '@assistant-ui/react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import type { Session } from '@/services/api';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

export function RecordSearchResults({ query, onOpen }: { query: string; onOpen?: () => void }) {
  const client = useLmaClient();
  const aui = useAui();
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [isDebounced, setIsDebounced] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setIsDebounced(true), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const search = useInfiniteQuery({
    queryKey: ['session-search', query],
    queryFn: ({ pageParam, signal }) => client.listSessions({ search: query, offset: pageParam, limit: PAGE_SIZE + 1 }, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.length > PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined),
    enabled: isDebounced,
  });
  const records = search.data?.pages.flatMap((page) => page.slice(0, PAGE_SIZE)) ?? [];
  const loading = !isDebounced || search.isFetching;
  const failed = search.isError;
  const hasMore = search.hasNextPage;
  const loadMoreOrRetry = () => {
    if (search.data) {
      void search.fetchNextPage();
    } else {
      void search.refetch();
    }
  };

  return (
    <div aria-label="搜索结果" aria-busy={loading}>
      {loading && records.length === 0 && <p role="status" className="px-2.5 py-4 text-sm text-muted-foreground">搜索中…</p>}
      {!loading && !failed && records.length === 0 && <p className="px-2.5 py-4 text-sm text-muted-foreground">未找到相关记录</p>}
      {openFailed && <p role="alert" className="p-2 text-sm">这条记录尚未打开，请重试。</p>}
      {records.map((record) => (
        <button key={record.id} type="button" disabled={opening !== null}
          className="flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition hover:bg-muted active:scale-99 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={async () => {
            setOpening(record.id);
            setOpenFailed(false);
            try {
              await aui.threads().switchToThread(record.id);
              onOpen?.();
            } catch {
              setOpenFailed(true);
            } finally {
              setOpening(null);
            }
          }}>
          <span className="min-w-0 flex-1 truncate">{record.name}</span>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={record.updated_at}>
            {new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(record.updated_at))}
          </time>
        </button>
      ))}
      {failed && <p role="alert" className="px-2.5 py-2 text-sm">搜索结果尚未载入</p>}
      {(failed || hasMore) && <Button variant="ghost" className="w-full" disabled={loading} onClick={loadMoreOrRetry}>{failed ? '重试' : loading ? '加载中…' : '加载更多结果'}</Button>}
    </div>
  );
}
