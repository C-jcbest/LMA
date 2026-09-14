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
  n?: number | null;
  e?: number | null;
  u?: number | null;
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
  input?: Record<string, unknown>;
  preview?: string;
  detail?: Record<string, unknown>;
  images?: ToolCallImage[];
  chartPoints?: ChartPoint[];
  siteEnvironment?: SiteEnvironmentArtifact;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: ToolCallInfo };

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  parts?: MessagePart[];
  tool_calls?: ToolCallInfo[];
}

export interface ThreadSession {
  thread_id: string;
  name: string;
  created_at: string;
  messages?: Message[];
  isGeneratingTitle?: boolean;
  status?: string;
}

const STORAGE_KEY_CONFIG = 'lma_langgraph_config';
const DEFAULT_API_URL = 'http://127.0.0.1:2024';

export const getStoredApiUrl = (): string => {
  return localStorage.getItem(STORAGE_KEY_CONFIG) || DEFAULT_API_URL;
};

export const setStoredApiUrl = (url: string) => {
  localStorage.setItem(STORAGE_KEY_CONFIG, url);
};

export const createLangGraphClient = (apiUrl?: string) => {
  const url = apiUrl || getStoredApiUrl();
  return new Client({
    apiUrl: url,
  });
};

export function projectThreadSessions(threads: any[]): ThreadSession[] {
  return threads
    .filter((thread) => typeof thread.metadata?.name === 'string' && thread.metadata.name.trim())
    .map((thread) => {
      if (!thread.created_at) throw new Error(`Thread ${thread.thread_id} 缺少 created_at`);
      return {
        thread_id: thread.thread_id,
        name: thread.metadata.name.trim(),
        created_at: thread.created_at,
        status: thread.status,
      };
    });
}

/**
 * 获取会话列表。只展示具有明确会话名称的业务 Thread；
 * session-title 无状态运行产生的临时 Thread 没有该元数据，不进入会话列表。
 */
export async function getSessions(): Promise<{ sessions: ThreadSession[]; isLive: boolean }> {
  const client = createLangGraphClient();
  const threads = await client.threads.search({ limit: 20 });
  const sessions = projectThreadSessions(threads);
  return { sessions, isLive: true };
}

/**
 * 新建会话（Thread）
 */
export async function createSession(name?: string, threadId?: string): Promise<ThreadSession> {
  const sessionName = name !== undefined ? name : '新建监测会话';
  const client = createLangGraphClient();
  const thread = await client.threads.create({
    threadId,
    metadata: { name: sessionName },
  });
  return {
    thread_id: thread.thread_id,
    name: sessionName,
    created_at: thread.created_at,
    messages: [],
  };
}

/**
 * 根据用户首条消息生成会话标题
 * 优先调用 LangGraph Server 的 session-title 无状态图（设置超时）。
 * 生成失败时抛出错误；调用方保留已确认的“新会话”状态并明确展示错误。
 */
export async function generateSessionTitle(userMessage: string): Promise<string> {
  const cleanInput = userMessage?.trim();
  if (!cleanInput) throw new Error('会话标题缺少首条消息');

  const client = createLangGraphClient();
  // 使用 Promise.race 设置 3.5 秒超时，避免阻塞用户感知
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('会话标题生成超时')), 3500)
  );

  const runPromise = (async () => {
    const res = await client.runs.wait(null, 'session-title', {
      input: { input_text: cleanInput },
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

  return Promise.race([runPromise, timeoutPromise]);
}


/**
 * 重命名会话
 */
export async function renameSession(threadId: string, newName: string): Promise<void> {
  const client = createLangGraphClient();
  await client.threads.update(threadId, {
    metadata: { name: newName },
  });
}

/**
 * 删除会话
 */
export async function deleteSession(threadId: string): Promise<void> {
  const client = createLangGraphClient();
  await client.threads.delete(threadId);
}

const messageText = (message: any): string => {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block: any) => block.text)
    .join('');
};

const parseToolDetail = (content: unknown): Record<string, unknown> | undefined => {
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return { raw: content };
  }
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

  const flushAssistant = (text: string, id?: string) => {
    if (pendingParts.length > 0) {
      const parts = [...pendingParts];
      if (text.trim()) parts.push({ type: 'text', content: text });
      result.push({ id, role: 'assistant', content: text, parts });
    } else if (text.trim()) {
      result.push({ id, role: 'assistant', content: text });
    }
    pendingParts = [];
  };

  for (const message of rawMsgs || []) {
    const type = message?.type || message?.getType?.() || message?._getType?.() || message?.role;
    const text = messageText(message);

    if (type === 'human' || type === 'user') {
      flushAssistant('');
      result.push({ id: message.id, role: 'user', content: text });
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
      const toolName = message.name || existingTool?.name;
      if (!callId || !toolName) {
        console.error('忽略缺少 tool_call_id 或 name 的非法 ToolMessage', message);
        continue;
      }
      const artifact = message.artifact || message.additional_kwargs?.artifact;
      const toolPart: MessagePart = {
        type: 'tool',
        toolCall: {
          id: callId,
          name: toolName,
          display_name: message.name || existingTool?.display_name || toolName,
          status:
            message.additional_kwargs?.lma_status === 'cancelled'
              ? 'cancelled'
              : message.status === 'error'
                ? 'error'
                : 'success',
          detail: parseToolDetail(text),
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
              input: call.args,
            },
          });
        }
      } else if (text.trim()) {
        flushAssistant(text, message.id);
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
 * Run 被用户中止时，服务端 checkpoint 可能停在 ai(tool_calls) 而没有对应
 * ToolMessage。先补齐结构化的取消结果，避免下一轮请求形成非法消息序列。
 */
export function getUnansweredToolCalls(
  rawMessages: unknown[]
): Array<{ id: string; name?: string }> {
  const messages = rawMessages as any[];
  const answered = new Set<string>();
  for (const message of messages) {
    const type = message?.type || message?.getType?.() || message?._getType?.() || message?.role;
    if (type === 'tool') {
      const id = message.tool_call_id || message.toolCallId;
      if (id) answered.add(id);
    }
  }

  const pending: Array<{ id: string; name?: string }> = [];
  const pendingIds = new Set<string>();
  for (const message of messages) {
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
      : Array.isArray(message?.toolCalls)
        ? message.toolCalls
        : [];
    for (const call of calls) {
      if (call?.id && !answered.has(call.id) && !pendingIds.has(call.id)) {
        pendingIds.add(call.id);
        pending.push({ id: call.id, name: call.name });
      }
    }
  }
  return pending;
}

export async function closeInterruptedToolCalls(
  threadId: string,
  rawMessages: unknown[] = []
): Promise<void> {
  const client = createLangGraphClient();
  // useStream.stop() 会发出服务端 interrupt 取消，但默认不等待服务端完全停止。
  // 按官方 cancel(wait=true, action='interrupt') 收敛仍在运行/排队的 run，
  // 再更新 checkpoint，避免工具结果与手工补齐发生竞态。
  const [running, pendingRuns] = await Promise.all([
    client.runs.list(threadId, { status: 'running', limit: 10 }),
    client.runs.list(threadId, { status: 'pending', limit: 10 }),
  ]);
  await Promise.all(
    [...running, ...pendingRuns].map((run) =>
      client.runs.cancel(threadId, run.run_id, true, 'interrupt')
    )
  );

  const state = await client.threads.getState(threadId);
  const checkpointMessages = Array.isArray((state.values as any)?.messages)
    ? ((state.values as any).messages as unknown[])
    : rawMessages;
  const unanswered = getUnansweredToolCalls(checkpointMessages);
  if (unanswered.length === 0) return;

  await client.threads.updateState(threadId, {
    values: {
      messages: unanswered.map((call) => ({
        type: 'tool',
        content: '该工具调用已由用户停止。',
        tool_call_id: call.id,
        name: call.name,
        status: 'error',
        additional_kwargs: { lma_status: 'cancelled' },
      })),
    } as any,
    asNode: 'tools',
  });
}
