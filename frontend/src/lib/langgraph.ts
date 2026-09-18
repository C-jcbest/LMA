import { Client } from '@langchain/langgraph-sdk';
import { LMA_ASSISTANT_ID } from '../app/config';

export interface ThreadSession {
  thread_id: string;
  name: string;
  created_at: string;
  updated_at?: string;
  status?: string;
}

// SDK HTTP 自动重试固定关闭（默认值/允许值均为 0，单位为重试次数）。
// 避免网络结果不确定时重发有副作用请求。
export const LANGGRAPH_CALLER_OPTIONS = Object.freeze({ maxRetries: 0 });

export function createLangGraphClient(apiUrl: string, defaultHeaders?: Record<string, string>): Client {
  return new Client({
    apiUrl,
    defaultHeaders,
    callerOptions: LANGGRAPH_CALLER_OPTIONS,
  });
}

export function projectThreadSessions(threads: any[]): ThreadSession[] {
  return threads
    .filter((thread) => thread.metadata?.graph_id === LMA_ASSISTANT_ID)
    .map((thread) => {
      if (!thread.created_at) throw new Error(`Thread ${thread.thread_id} 缺少 created_at`);
      return {
        thread_id: thread.thread_id,
        name: typeof thread.metadata?.name === 'string' && thread.metadata.name.trim() ? thread.metadata.name.trim() : '新会话',
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        status: thread.status,
      };
    });
}

export const SESSION_PAGE_SIZE = 20;

export async function getSessions(
  client: Client,
  offset = 0
): Promise<{ sessions: ThreadSession[]; nextOffset: number; hasMore: boolean }> {
  const threads = await client.threads.search({
    metadata: { graph_id: LMA_ASSISTANT_ID },
    limit: SESSION_PAGE_SIZE,
    offset,
    sortBy: 'updated_at',
    sortOrder: 'desc',
    select: ['thread_id', 'metadata', 'created_at', 'updated_at', 'status'],
  });
  const sessions = projectThreadSessions(threads);
  return { sessions, nextOffset: offset + threads.length, hasMore: threads.length === SESSION_PAGE_SIZE };
}

export async function getBusySessions(client: Client, ids: string[]): Promise<ThreadSession[]> {
  if (!ids.length) return [];
  const threads = await client.threads.search({
    metadata: { graph_id: LMA_ASSISTANT_ID },
    ids,
    limit: ids.length,
    select: ['thread_id', 'metadata', 'created_at', 'updated_at', 'status'],
  });
  const sessions = projectThreadSessions(threads);
  if (ids.some((id) => !sessions.some((item) => item.thread_id === id))) {
    throw new Error('部分会话状态未获得确认');
  }
  return sessions;
}

export function mergeSessions(current: ThreadSession[], incoming: ThreadSession[]): ThreadSession[] {
  const items = new Map(current.map((item) => [item.thread_id, item]));
  for (const item of incoming) items.set(item.thread_id, item);
  return [...items.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.thread_id.localeCompare(b.thread_id));
}

export async function renameSession(client: Client, threadId: string, newName: string): Promise<void> {
  await client.threads.update(threadId, {
    metadata: { name: newName },
  });
}

export async function deleteSession(client: Client, threadId: string): Promise<void> {
  await client.threads.delete(threadId);
}
