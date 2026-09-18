import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { getApiUrl } from '../../app/config';
import { createLangGraphClient, renameSession, deleteSession } from '../../lib/langgraph';
import { threadKeys } from './threadQueries';

export function useRenameThreadMutation() {
  const queryClient = useQueryClient();
  const apiUrl = useMemo(() => getApiUrl(), []);
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);

  return useMutation({
    mutationFn: async ({ threadId, newName }: { threadId: string; newName: string }) => {
      const trimmed = newName.trim();
      if (!trimmed) {
        throw new Error('会话标题不能为空');
      }
      await renameSession(client, threadId, trimmed);
      return { threadId, newName: trimmed };
    },
    onSuccess: () => {
      toast.success('已修改会话标题');
      queryClient.invalidateQueries({ queryKey: threadKeys.all });
    },
    onError: (err: any) => {
      toast.error(err.message || '修改会话标题失败');
    },
  });
}

export function useDeleteThreadMutation() {
  const queryClient = useQueryClient();
  const apiUrl = useMemo(() => getApiUrl(), []);
  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);

  return useMutation({
    mutationFn: async ({ threadId }: { threadId: string }) => {
      await deleteSession(client, threadId);
      return { threadId };
    },
    onSuccess: () => {
      toast.success('已删除会话');
      queryClient.invalidateQueries({ queryKey: threadKeys.all });
    },
    onError: (err: any) => {
      toast.error(err.message || '删除会话失败');
    },
  });
}
