import type { Client } from '@langchain/langgraph-sdk';
import type { RemoteThreadListAdapter } from '@assistant-ui/react';
import { createAssistantStream, type AssistantStream } from 'assistant-stream';
import {
  LMA_ASSISTANT_ID,
  generateSessionTitle,
  renameSession,
} from '@/services/api';

const PAGE_SIZE = 20;

/**
 * 将 LangGraph Server 官方 Thread API 适配为 assistant-ui RemoteThreadListAdapter。
 * 遵循官方 LangGraph 规范：
 * 明确保证 remoteId === externalId === thread_id，
 * 使得 Thread List 选中的 ID 与真正传递给底层 useStream 的 LangGraph thread_id 严格对齐。
 */
export function createLangGraphThreadListAdapter(
  client: Client,
  assistantId: string = LMA_ASSISTANT_ID
): RemoteThreadListAdapter {
  return {
    async list(params) {
      const offset = params?.after ? parseInt(params.after, 10) : 0;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

      const threads = await client.threads.search({
        metadata: { graph_id: assistantId },
        // 多查询一条判断末页，避免整页结束后仍显示加载入口。
        limit: PAGE_SIZE + 1,
        offset: safeOffset,
        sortBy: 'updated_at',
        sortOrder: 'desc',
        select: ['thread_id', 'metadata', 'created_at', 'updated_at', 'status'],
      });

      const remoteThreads = threads.slice(0, PAGE_SIZE).map((thread) => ({
        status: thread.metadata?.archived ? ('archived' as const) : ('regular' as const),
        remoteId: thread.thread_id,
        externalId: thread.thread_id,
        title:
          typeof thread.metadata?.name === 'string' && thread.metadata.name.trim()
            ? thread.metadata.name.trim()
            : '新会话',
        lastMessageAt: thread.updated_at
          ? new Date(thread.updated_at)
          : thread.created_at
            ? new Date(thread.created_at)
            : undefined,
      }));

      const nextCursor =
        threads.length > PAGE_SIZE ? String(safeOffset + PAGE_SIZE) : undefined;

      return {
        threads: remoteThreads,
        nextCursor,
      };
    },

    async initialize() {
      const created = await client.threads.create({
        metadata: {
          graph_id: assistantId,
          name: '新会话',
        },
      });
      return {
        remoteId: created.thread_id,
        externalId: created.thread_id,
      };
    },

    async rename(remoteId: string, newTitle: string): Promise<void> {
      const cleanTitle = newTitle.trim();
      if (!cleanTitle) return;
      await renameSession(client, remoteId, cleanTitle);
    },

    async delete(remoteId: string): Promise<void> {
      await client.threads.delete(remoteId);
    },

    async archive(remoteId: string): Promise<void> {
      await client.threads.update(remoteId, {
        metadata: { archived: true },
      });
    },

    async unarchive(remoteId: string): Promise<void> {
      await client.threads.update(remoteId, {
        metadata: { archived: false },
      });
    },

    async fetch(threadId: string) {
      const thread = await client.threads.get(threadId);
      return {
        status: thread.metadata?.archived ? ('archived' as const) : ('regular' as const),
        remoteId: thread.thread_id,
        externalId: thread.thread_id,
        title:
          typeof thread.metadata?.name === 'string' && thread.metadata.name.trim()
            ? thread.metadata.name.trim()
            : '新会话',
        lastMessageAt: thread.updated_at
          ? new Date(thread.updated_at)
          : thread.created_at
            ? new Date(thread.created_at)
            : undefined,
      };
    },

    async generateTitle(
      remoteId,
      unstable_messages
    ): Promise<AssistantStream> {
      return createAssistantStream(async (controller) => {
        const userMsg = unstable_messages.find((m) => m.role === 'user');
        let userText = '';
        if (userMsg) {
          if (typeof userMsg.content === 'string') {
            userText = userMsg.content;
          } else if (Array.isArray(userMsg.content)) {
            userText = userMsg.content
              .filter(
                (part: any): part is { type: 'text'; text: string } =>
                  Boolean(part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
              )
              .map((p: { type: 'text'; text: string }) => p.text)
              .join('\n');
          }
        }

        const cleanText = userText.trim();
        if (!cleanText) return;

        try {
          const generatedTitle = await generateSessionTitle(client, cleanText);
          if (generatedTitle) {
            await renameSession(client, remoteId, generatedTitle);
            controller.appendText(generatedTitle);
          }
        } catch (err) {
          console.warn('异步生成会话标题失败:', err);
        }
      });
    },
  };
}
