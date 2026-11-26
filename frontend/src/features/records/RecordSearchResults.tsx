import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useAui } from '@assistant-ui/react';
import { Loader2Icon } from 'lucide-react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { StatusDot } from '@/features/monitoring/status';
import { cn } from 'cn';
import { matchesSessionStatusFilter, useSessionVerdicts, type SessionStatusFilter } from './SessionConclusions';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

export function RecordSearchResults({
  query,
  statusFilter = 'all',
  onOpen,
}: {
  query: string;
  statusFilter?: SessionStatusFilter;
  onOpen?: () => void;
}) {
  const client = useLmaClient();
  const aui = useAui();
  const verdicts = useSessionVerdicts();
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = useInfiniteQuery({
    queryKey: ['session-search', debouncedQuery],
    queryFn: ({ pageParam, signal }) => client.listSessions({ search: debouncedQuery, offset: pageParam, limit: PAGE_SIZE + 1 }, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (lastPage.length > PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined),
    placeholderData: keepPreviousData,
  });
  const allRecords = search.data?.pages.flatMap((page) => page.slice(0, PAGE_SIZE)) ?? [];
  const records = allRecords.filter((record) => matchesSessionStatusFilter(verdicts.get(record.id), statusFilter));
  const loading = query !== debouncedQuery || search.isFetching;
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
      {!loading && !failed && records.length === 0 && (
        <p className="px-2.5 py-4 text-sm text-muted-foreground">
          {hasMore ? '已加载的记录中未匹配当前筛选，可继续加载更多' : '未找到相关记录'}
        </p>
      )}
      {openFailed && <p role="alert" className="p-2 text-sm text-destructive">这条记录尚未打开，请重试。</p>}
      {records.map((record) => {
        const verdict = verdicts.get(record.id);
        const isOpeningThis = opening === record.id;
        return (
          <button
            key={record.id}
            type="button"
            disabled={opening !== null}
            aria-busy={isOpeningThis}
            className={cn(
              'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition hover:bg-muted active:scale-99 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isOpeningThis && 'bg-muted/70',
              opening !== null && !isOpeningThis && 'opacity-70',
            )}
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
            }}
          >
            {isOpeningThis ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <StatusDot status={verdict?.status} className={verdict ? undefined : 'invisible'} />
            )}
            <span className="min-w-0 flex-1 truncate">{record.name}</span>
            {verdict && (
              <span className="text-muted-foreground max-w-2/5 shrink-0 truncate text-xs">
                {verdict.stations.join('、')} · {investigationStatusLabel(verdict.status)}
              </span>
            )}
            <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={record.updated_at}>
              {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(record.updated_at))}
            </time>
          </button>
        );
      })}
      {failed && <p role="alert" className="px-2.5 py-2 text-sm">搜索结果尚未载入</p>}
      {(failed || hasMore) && <Button variant="ghost" className="w-full" disabled={loading} onClick={loadMoreOrRetry}>{failed ? '重试' : loading ? '加载中…' : '加载更多结果'}</Button>}
    </div>
  );
}
