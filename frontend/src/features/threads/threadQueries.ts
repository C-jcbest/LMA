import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getApiUrl } from '../../app/config';
import { createLangGraphClient, getSessions, ThreadSession } from '../../lib/langgraph';

export const threadKeys = {
  all: ['threads'] as const,
  list: () => [...threadKeys.all, 'list'] as const,
};

export function useThreadListQuery() {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);

  return useInfiniteQuery({
    queryKey: threadKeys.list(),
    queryFn: async ({ pageParam = 0 }) => {
      return getSessions(client, pageParam as number);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextOffset : undefined),
    staleTime: 30_000,
  });
}

/**
 * 展平所有分页中的 ThreadSession 列表
 */
export function useFlatThreadList() {
  const query = useThreadListQuery();

  const sessions = useMemo(() => {
    if (!query.data?.pages) return [];
    const map = new Map<string, ThreadSession>();
    for (const page of query.data.pages) {
      for (const session of page.sessions) {
        map.set(session.thread_id, session);
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '') ||
        a.thread_id.localeCompare(b.thread_id)
    );
  }, [query.data]);

  return {
    ...query,
    sessions,
  };
}
