import { Client } from '@langchain/langgraph-sdk';

export interface ToolCallImage {
  name: string;
  // 后端下发的图表中文标题（含基线口径）
  title?: string;
  png_base64: string;
}

// 视觉复核随 artifact 转发的全量图表数据序列（后端 chart_points）
export interface ChartPoint {
  t: string;
  n?: number | string | null;
  e?: number | string | null;
  u?: number | string | null;
}

export interface SiteStation {
  station_uuid: string;
  station_name: string;
  group_name?: string;
  station_type?: string;
  station_status?: string;
  location?: string;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  coordinate_system: 'WGS84';
}

export interface SiteEnvironmentArtifact {
  version: number;
  observed_at?: string;
  coordinate_system: 'WGS84';
  center_station: SiteStation;
  group_stations: SiteStation[];
  terrain?: {
    dem_elevation_m?: number;
    slope_degrees?: number;
    aspect_degrees?: number;
    aspect?: string;
    relief_500m_m?: number;
    resolution_m?: number;
  } | null;
  geology?: {
    name?: string;
    lithology?: string;
    age?: string;
    description?: string;
    color?: string;
    source_reference?: string;
  } | null;
  faults?: { available?: boolean; distance_km?: number | null; note?: string };
  layer_sources?: {
    geology_tiles?: string;
    geology_source_layer?: string;
    fault_source_layer?: string;
  };
  sources?: Array<{ name: string; role?: string; url?: string; license?: string }>;
  limitations?: string[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  display_name: string;
  icon?: string;
  status: 'loading' | 'success' | 'error' | 'cancelled';
  data?: Record<string, unknown>;
  images?: ToolCallImage[];
  chartPoints?: ChartPoint[];
  siteEnvironment?: SiteEnvironmentArtifact;
}

export interface ThinkingInfo {
  content: string;
  duration_ms?: number;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'thinking'; thinking: ThinkingInfo }
  | { type: 'tool'; toolCall: ToolCallInfo };

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  created_at?: string;
  parts?: MessagePart[];
  tool_calls?: ToolCallInfo[];
}

export interface ThreadSession {
  thread_id: string;
  name: string;
  created_at: string;
  updated_at: string;
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
      if (!thread.updated_at || !Number.isFinite(Date.parse(thread.updated_at))) throw new Error('会话缺少有效更新时间');
      return {
        thread_id: thread.thread_id,
        name: typeof thread.metadata.name === 'string' && thread.metadata.name.trim() ? thread.metadata.name.trim() : '新会话',
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        status: thread.status,
      };
    });
}

/**
 * 按官方 graph_id 归属分页，只查询列表字段，不拉取 checkpoint/values。
 */
export async function getSessions(client: Client, offset = 0): Promise<{ sessions: ThreadSession[]; isLive: boolean; nextOffset: number; hasMore: boolean }> {
  const threads = await client.threads.search({ metadata: { graph_id: LMA_ASSISTANT_ID }, limit: THREAD_PAGE_SIZE, offset,
    sortBy: 'updated_at', sortOrder: 'desc', select: [...THREAD_LIST_FIELDS] });
  const sessions = projectThreadSessions(threads);
  return { sessions, isLive: true, nextOffset: offset + threads.length, hasMore: threads.length === THREAD_PAGE_SIZE };
}

// 会话列表固定每页20条；单位为条，适用于分页，不限制会话总数。
export const THREAD_PAGE_SIZE = 20;
const THREAD_LIST_FIELDS = ['thread_id', 'created_at', 'updated_at', 'metadata', 'status'] as const;

export function mergeThreadSessions(...pages: ThreadSession[][]): ThreadSession[] {
  const byId = new Map<string, ThreadSession>();
  for (const session of pages.flat()) {
    const previous = byId.get(session.thread_id);
    if (!previous || Date.parse(session.updated_at) >= Date.parse(previous.updated_at)) byId.set(session.thread_id, session);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.thread_id.localeCompare(b.thread_id));
}

export async function getSessionStatuses(client: Client, ids: string[]): Promise<ThreadSession[]> {
  if (!ids.length) return [];
  const threads = await client.threads.search({ ids, metadata: { graph_id: LMA_ASSISTANT_ID }, limit: ids.length,
    select: [...THREAD_LIST_FIELDS], sortBy: 'updated_at', sortOrder: 'desc' });
  const sessions = projectThreadSessions(threads);
  if (ids.some((id) => !sessions.some((session) => session.thread_id === id))) throw new Error('部分会话未返回运行状态');
  return sessions;
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
export async function renameSession(client: Client, threadId: string, newName: string) {
  return await client.threads.update(threadId, {
    metadata: { name: newName },
  });
}

const messageText = (message: any): string => {
  let raw = '';
  if (typeof message?.content === 'string') {
    raw = message.content;
  } else if (Array.isArray(message?.content)) {
    raw = message.content
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('');
  }
  if (!raw) return '';

  // 如果字符串内容中包含 <think> 标签，将思考部分剔除，仅保留真实回复正文
  if (raw.includes('<think>')) {
    const endThinkIdx = raw.indexOf('</think>');
    if (endThinkIdx !== -1) {
      return raw.slice(endThinkIdx + 8).trimStart();
    }
    // 仍在思考流输出阶段（未闭合），正文尚未开始
    return '';
  }

  return raw;
};

const messageThinking = (message: any): ThinkingInfo | undefined => {
  let content = '';

  // 1. 优先读取 additional_kwargs (支持 reasoning_content / reasoning / thinking)
  const addKwargs = message?.additional_kwargs;
  if (typeof addKwargs?.reasoning_content === 'string' && addKwargs.reasoning_content.trim()) {
    content = addKwargs.reasoning_content;
  } else if (typeof addKwargs?.reasoning === 'string' && addKwargs.reasoning.trim()) {
    content = addKwargs.reasoning;
  } else if (typeof addKwargs?.thinking === 'string' && addKwargs.thinking.trim()) {
    content = addKwargs.thinking;
  }

  // 2. 检查 response_metadata
  if (!content) {
    const respMeta = message?.response_metadata;
    if (typeof respMeta?.reasoning_content === 'string' && respMeta.reasoning_content.trim()) {
      content = respMeta.reasoning_content;
    } else if (typeof respMeta?.reasoning === 'string' && respMeta.reasoning.trim()) {
      content = respMeta.reasoning;
    }
  }

  // 3. 检查直接挂在 message 根属性上的 reasoning_content / reasoning
  if (!content) {
    if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
      content = message.reasoning_content;
    } else if (typeof message?.reasoning === 'string' && message.reasoning.trim()) {
      content = message.reasoning;
    }
  }

  // 4. 检查 content 为数组时的 reasoning / thinking content blocks (LangGraph SDK v2 / protocol 块流)
  if (!content && Array.isArray(message?.content)) {
    const parts: string[] = [];
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'reasoning' || block.type === 'thinking' || block.type === 'thought') {
        const t = block.reasoning || block.thinking || block.thought || block.text;
        if (typeof t === 'string' && t) parts.push(t);
      }
    }
    if (parts.length > 0) {
      content = parts.join('');
    }
  }

  // 5. 检查 content 为字符串时夹带的 <think>...</think> 或流式输出中未闭合的 <think>
  if (!content && typeof message?.content === 'string' && message.content.includes('<think>')) {
    const startIdx = message.content.indexOf('<think>') + 7;
    const endIdx = message.content.indexOf('</think>');
    if (endIdx !== -1) {
      content = message.content.slice(startIdx, endIdx);
    } else {
      // 正在流式输出思考内容，尚未输出 </think>
      content = message.content.slice(startIdx);
    }
  }

  if (!content || !content.trim()) return undefined;

  const rawDuration =
    message?.additional_kwargs?.lma_thinking_duration_ms ??
    message?.response_metadata?.lma_thinking_duration_ms;

  return {
    content,
    duration_ms:
      typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
        ? rawDuration
        : undefined,
  };
};

/**
 * 将 useStream 的服务端权威消息投影为现有聊天 UI 结构。
 * 该函数无缓存和副作用；每次都从 Thread 消息重新派生，避免维护第二份历史。
 */
export function projectLangGraphMessages(
  rawMsgs: any[],
  options: { isRunActive?: boolean } = {}
): Message[] {
  const result: Message[] = [];
  let pendingParts: MessagePart[] = [];

  const flushAssistant = (text: string, id?: string, createdAt?: string) => {
    if (pendingParts.length > 0) {
      const parts = [...pendingParts];
      if (text.trim()) parts.push({ type: 'text', content: text });
      result.push({ id, role: 'assistant', content: text, created_at: createdAt, parts });
    } else if (text.trim()) {
      result.push({ id, role: 'assistant', content: text, created_at: createdAt });
    }
    pendingParts = [];
  };

  for (const message of rawMsgs || []) {
    // 官方内部摘要是带来源标记的 HumanMessage，不属于真实用户发言。
    if (message?.additional_kwargs?.lc_source === 'summarization') continue;
    const type = message?.type || message?.getType?.() || message?._getType?.() || message?.role;
    const text = messageText(message);
    const thinking = messageThinking(message);
    const rawCreatedAt = message?.additional_kwargs?.created_at || message?.created_at;
    const msgCreatedAt = typeof rawCreatedAt === 'string' ? rawCreatedAt : undefined;

    if (type === 'human' || type === 'user') {
      flushAssistant('');
      result.push({ id: message.id, role: 'user', content: text, created_at: msgCreatedAt });
      continue;
    }

    if (type === 'tool') {
      const callId = message.tool_call_id || message.toolCallId || message.id;
      const index = pendingParts.findIndex(
        (part) => part.type === 'tool' && part.toolCall.id === callId
      );
      const existingTool =
        index >= 0 && pendingParts[index].type === 'tool'
          ? pendingParts[index].toolCall
          : undefined;
      if (message.additional_kwargs?.lma_protocol === 'interrupted_tool_call') {
        if (existingTool) existingTool.status = 'cancelled';
        continue;
      }
      const toolName = message.name || existingTool?.name;
      if (!callId || !toolName) {
        console.error('忽略缺少 tool_call_id 或 name 的非法 ToolMessage', message);
        continue;
      }
      const artifact = message.artifact;
      const toolPart: MessagePart = {
        type: 'tool',
        toolCall: {
          id: callId,
          name: toolName,
          display_name: message.name || existingTool?.display_name || toolName,
          status:
            message.status === 'error'
                ? 'error'
                : 'success',
          data: message.status === 'error' && text === 'Tool call limit exceeded. Do not make additional tool calls.'
            ? { message: '本轮查询次数已达到上限，未执行此查询；请依据已有证据继续分析。' }
            : artifact?.data && typeof artifact.data === 'object' && !Array.isArray(artifact.data)
            ? artifact.data
            : undefined,
          images: Array.isArray(artifact?.images)
            ? artifact.images.filter((image: any) => image?.name && typeof image?.png_base64 === 'string')
            : undefined,
          chartPoints: Array.isArray(artifact?.chart_points) ? artifact.chart_points : undefined,
          siteEnvironment:
            artifact?.site_environment && typeof artifact.site_environment === 'object'
              ? artifact.site_environment
              : undefined,
        },
      };
      if (index >= 0) pendingParts[index] = toolPart;
      else pendingParts.push(toolPart);
      continue;
    }

    if (type === 'ai' || type === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : Array.isArray(message.toolCalls)
          ? message.toolCalls
          : [];
      if (toolCalls.length > 0) {
        if (thinking) pendingParts.push({ type: 'thinking', thinking });
        if (text.trim()) pendingParts.push({ type: 'text', content: text });
        for (const call of toolCalls) {
          if (!call?.id || !call?.name || pendingParts.some((part) => part.type === 'tool' && part.toolCall.id === call.id)) continue;
          pendingParts.push({
            type: 'tool',
            toolCall: {
              id: call.id,
              name: call.name,
              display_name: call.name,
              status: 'loading',
            },
          });
        }
      } else if (text.trim() || thinking) {
        if (thinking) pendingParts.push({ type: 'thinking', thinking });
        flushAssistant(text, message.id, msgCreatedAt);
      }
    }
  }
  if (options.isRunActive === false) {
    pendingParts = pendingParts.map((part) =>
      part.type === 'tool' && part.toolCall.status === 'loading'
        ? { ...part, toolCall: { ...part.toolCall, status: 'cancelled' } }
        : part
    );
  }
  flushAssistant('');
  return result;
}

/**
 * 仅检查服务端消息最后一个真实用户回合中的最新AI工具批次。
 * 此函数只构造协议消息；是否属于已中止Run由调用方读取Server确认。
 */
export function getInterruptedToolMessages(
  rawMessages: unknown[]
) {
  const messages = rawMessages as any[];
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === 'human' && messages[i]?.additional_kwargs?.lc_source !== 'summarization') { userIndex = i; break; }
  }
  if (userIndex < 0) return [];
  let batchIndex = -1;
  for (let i = messages.length - 1; i > userIndex; i--) {
    if (messages[i]?.type === 'ai' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length) { batchIndex = i; break; }
  }
  if (batchIndex < 0) return [];
  const answered = new Set(messages.slice(batchIndex + 1).filter((message) => message?.type === 'tool').map((message) => message.tool_call_id));
  const calls = messages[batchIndex].tool_calls as Array<{ id: string; name: string }>;
  if (calls.some((call) => !call.id || !call.name) || new Set(calls.map((call) => call.id)).size !== calls.length) throw new Error('工具批次协议无效');
  return calls.filter((call) => !answered.has(call.id)).map((call) => ({
    type: 'tool' as const, content: '该工具调用在完成前被用户中止，未获得结果。',
    tool_call_id: call.id, name: call.name, status: 'error' as const,
    additional_kwargs: { lma_protocol: 'interrupted_tool_call' },
  }));
}

export async function prepareThreadInput(client: Client, threadId: string, text: string) {
  const thread = await client.threads.get(threadId);
  if (thread.status === 'busy') throw new Error('会话仍在运行');
  const [latestRuns, state] = await Promise.all([client.runs.list(threadId, { limit: 1 }), client.threads.getState(threadId)]);
  if (latestRuns[0]?.status === 'pending' || latestRuns[0]?.status === 'running') throw new Error('会话仍在运行');
  const messages = (state.values as any)?.messages;
  if (!Array.isArray(messages)) throw new Error('服务端会话历史不可用');
  const protocol = latestRuns[0]?.status === 'interrupted' ? getInterruptedToolMessages(messages) : [];
  return [...protocol, { type: 'human' as const, content: text }];
}

/** 主 Run 的失败只展示受控说明，内部异常留在服务端。 */
export function runErrorMessage(error: unknown): string {
  const value = error as { name?: unknown; message?: unknown } | null;
  if (value?.name === 'ModelCallLimitExceededError' ||
      (typeof value?.message === 'string' && value.message.startsWith('Model call limits exceeded:'))) {
    return '本轮分析次数已达到上限，已保留现有记录。请缩小查询范围后继续。';
  }
  return '本次请求未完成，已保留现有记录，请稍后重试。';
}
