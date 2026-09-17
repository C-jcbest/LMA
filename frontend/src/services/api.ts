import { Client } from '@langchain/langgraph-sdk';
import { AIMessage, RemoveMessage } from '@langchain/core/messages';


export interface ThreadSession {
  thread_id: string;
  name: string;
  created_at: string;
  updated_at?: string;
  status?: string;
}

const STORAGE_KEY_CONFIG = 'lma_langgraph_config';
const DEFAULT_API_URL = 'http://127.0.0.1:2024';

// SDK HTTP 自动重试固定关闭（默认值/允许值均为 0，单位为重试次数）。
// 作用于 Thread CRUD、Run 提交与标题 HTTP 请求，避免网络结果不确定时重发有副作用请求。
// 主 Agent 模型/工具的瞬时重试仍由后端官方 middleware 管理，不受此策略影响。
export const LANGGRAPH_CALLER_OPTIONS = Object.freeze({ maxRetries: 0 });
export const LMA_ASSISTANT_ID = 'lma-agent';
const TITLE_ASSISTANT_ID = 'session-title';

export const getStoredApiUrl = (): string => {
  return localStorage.getItem(STORAGE_KEY_CONFIG) || DEFAULT_API_URL;
};

export const setStoredApiUrl = (url: string) => {
  localStorage.setItem(STORAGE_KEY_CONFIG, url);
};

export const createLangGraphClient = (apiUrl: string, defaultHeaders?: Record<string, string>) => {
  return new Client({
    apiUrl,
    defaultHeaders,
    callerOptions: LANGGRAPH_CALLER_OPTIONS,
  });
};

export function projectThreadSessions(threads: any[]): ThreadSession[] {
  return threads
    .filter((thread) => thread.metadata?.graph_id === LMA_ASSISTANT_ID)
    .map((thread) => {
      if (!thread.created_at) throw new Error(`Thread ${thread.thread_id} 缺少 created_at`);
      return {
        thread_id: thread.thread_id,
        name: typeof thread.metadata.name === 'string' && thread.metadata.name.trim() ? thread.metadata.name.trim() : '新会话',
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        status: thread.status,
      };
    });
}

export const SESSION_PAGE_SIZE = 20;

/** 服务端负责业务归属、排序与分页；返回原始页长度用于 offset，不按展示数量推算。 */
export async function getSessions(client: Client, offset = 0): Promise<{ sessions: ThreadSession[]; nextOffset: number; hasMore: boolean }> {
  const threads = await client.threads.search({
    metadata: { graph_id: LMA_ASSISTANT_ID }, limit: SESSION_PAGE_SIZE, offset,
    sortBy: 'updated_at', sortOrder: 'desc', select: ['thread_id', 'metadata', 'created_at', 'updated_at', 'status'],
  });
  const sessions = projectThreadSessions(threads);
  return { sessions, nextOffset: offset + threads.length, hasMore: threads.length === SESSION_PAGE_SIZE };
}

export async function getBusySessions(client: Client, ids: string[]): Promise<ThreadSession[]> {
  if (!ids.length) return [];
  const threads = await client.threads.search({
    metadata: { graph_id: LMA_ASSISTANT_ID }, ids, limit: ids.length,
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

/**
 * 根据用户首条消息生成会话标题
 * 优先调用 LangGraph Server 的 session-title 无状态图（设置超时）。
 * 生成失败时抛出错误；调用方保留服务端已确认的“新会话”，不污染聊天错误。
 */
export async function generateSessionTitle(client: Client, userMessage: string): Promise<string> {
  const cleanInput = userMessage?.trim();
  if (!cleanInput) throw new Error('会话标题缺少首条消息');

  // 官方 SDK 接收 AbortSignal；超时取消请求，完成后清除计时器。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  const runPromise = (async () => {
    const res = await client.runs.wait(null, TITLE_ASSISTANT_ID, {
      input: { input_text: cleanInput },
      signal: controller.signal,
    });
    if (res && typeof res === 'object') {
      const title = (res as any).title;
      if (typeof title === 'string' && title.trim()) {
        const cleanTitle = title
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .split(/\r?\n/, 1)[0]
          .trim()
          .replace(/^["'“”]+|["'“”]+$/g, '')
          .trim();
        if (cleanTitle && cleanTitle.length <= 80) return cleanTitle;
      }
    }
    throw new Error('服务端未返回有效会话标题');
  })();

  try {
    return await runPromise;
  } finally {
    clearTimeout(timer);
  }
}


/**
 * 重命名会话
 */
export async function renameSession(client: Client, threadId: string, newName: string): Promise<void> {
  await client.threads.update(threadId, {
    metadata: { name: newName },
  });
}


/**
 * 检查最终 checkpoint 中的全部 AI tool-call 消息，返回需要清除或收窄的消息。
 * ToolMessage 只有紧随其 AIMessage 的连续工具结果才构成有效配对；整批均未完成时
 * 删除 AIMessage，并行批次部分完成时原位保留已有 ToolMessage 对应的 calls。
 *
 * 不能只检查最后一个 HumanMessage 之后：一次失败重试会先把新的 HumanMessage 写入
 * checkpoint，使上一次停止遗留的未配对 AIMessage 落到“当前回合”之前。
 */
export function getIncompleteToolCallMessageUpdates(rawMessages: unknown[]): Array<RemoveMessage | AIMessage> {
  const messages = rawMessages as any[];
  const updates: Array<RemoveMessage | AIMessage> = [];
  const messageType = (message: any) => message?.type;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const type = messageType(message);
    if (type !== 'ai') continue;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!calls.length) continue;

    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messageType(messages[next]) === 'tool'; next += 1) {
      const id = messages[next]?.tool_call_id;
      if (id) answered.add(id);
    }
    if (calls.every((call: any) => call?.id && answered.has(call.id))) continue;
    if (!message.id) throw new Error('未完成工具调用缺少消息 ID，无法安全清理');
    const completedCalls = calls.filter((call: any) => call?.id && answered.has(call.id));
    if (completedCalls.length === 0) updates.push(new RemoveMessage({ id: message.id }));
    else updates.push(new AIMessage({
      id: message.id,
      content: message.content ?? '',
      additional_kwargs: message.additional_kwargs ?? {},
      response_metadata: message.response_metadata ?? {},
      tool_calls: completedCalls,
      usage_metadata: message.usage_metadata,
    }));
  }
  return updates;
}

export async function removeIncompleteToolCallMessages(
  client: Client,
  threadId: string
): Promise<void> {
  // stop() 已对当前 Run 发出 interrupt cancel；此处只读取最终 checkpoint，不再扫描、
  // cancel 其它 Run，也不构造 resume/HITL 或 ToolMessage。
  const state = await client.threads.getState(threadId);
  const messages = Array.isArray((state.values as any)?.messages) ? (state.values as any).messages : [];
  const updates = getIncompleteToolCallMessageUpdates(messages);
  if (!updates.length) return;

  // 必须传 LangChain Message 实例，让 SDK 序列化为 lc constructor。生产 Agent
  // Server 不接受 JS 文档中的简写 {type:'remove', id} 作为远程 updateState 输入。
  await client.threads.updateState(threadId, {
    values: { messages: updates } as any,
  });
}
