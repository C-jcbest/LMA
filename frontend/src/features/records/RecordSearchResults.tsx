import { useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import type { Session } from '@/services/api';

const PAGE_SIZE = 20;

export function RecordSearchResults({ query, onOpen }: { query: string; onOpen?: () => void }) {
  const client = useLmaClient();
  const aui = useAui();
  const [records, setRecords] = useState<Session[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = async (offset: number, signal: AbortSignal) => {
    setLoading(true);
    setFailed(false);
    try {
      const result = await client.listSessions({ search: query, offset, limit: PAGE_SIZE + 1 }, signal);
      if (signal.aborted) {
        return;
      }
      setRecords((previous) => offset === 0 ? result.slice(0, PAGE_SIZE) : [...previous, ...result.slice(0, PAGE_SIZE)]);
      setHasMore(result.length > PAGE_SIZE);
    } catch {
      if (!signal.aborted) {
        setFailed(true);
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    const timer = window.setTimeout(() => { void load(0, request.signal); }, 250);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [client, query]);

  return (
    <div aria-label="搜索结果" aria-busy={loading}>
      {loading && records.length === 0 && <p role="status" className="px-2.5 py-4 text-sm text-muted-foreground">搜索中…</p>}
      {!loading && !failed && records.length === 0 && <p className="px-2.5 py-4 text-sm text-muted-foreground">未找到相关记录</p>}
      {openFailed && <p role="alert" className="p-2 text-sm">这条记录尚未打开，请重试。</p>}
      {records.map((record) => (
        <button key={record.id} type="button" disabled={opening !== null}
          className="flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      {(failed || hasMore) && <Button variant="ghost" className="w-full" disabled={loading} onClick={() => {
        if (controller.current) {
          void load(records.length, controller.current.signal);
        }
      }}>{failed ? '重试' : loading ? '加载中…' : '加载更多结果'}</Button>}
    </div>
  );
}
