import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLangGraphClient, renameSession, deleteSession } from '../../lib/langgraph';
import { threadKeys } from './threadQueries';

export function useRenameThreadMutation() {
  const queryClient = useQueryClient();
  const client = useLangGraphClient();

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
  const client = useLangGraphClient();

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
