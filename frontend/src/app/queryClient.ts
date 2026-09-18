import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0, // 不盲目自动重试
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30, // 30秒缓存
    },
    mutations: {
      retry: 0,
    },
  },
});
