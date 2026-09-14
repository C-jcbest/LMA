import { Client } from '@langchain/langgraph-sdk';

export interface ToolCallImage {
  name: string;
  // 后端下发的图表中文标题（含基线口径），缺省时前端按 name 映射兑底
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
  status: 'loading' | 'success' | 'error';
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
const STORAGE_KEY_SESSIONS = 'lma_cached_sessions';
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

// 默认空会话列表（已移除所有前端模拟消息）
export const PROTOTYPE_SESSIONS: ThreadSession[] = [];

// 本地存储支持
const loadStoredSessions = (): ThreadSession[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
    if (raw) {
      const parsed: ThreadSession[] = JSON.parse(raw);
      // 清理历史残留的原型模拟会话
      const realSessions = parsed.filter(
        (s) => s && s.thread_id && !s.thread_id.startsWith('thread-proto-')
      );
      if (realSessions.length !== parsed.length) {
        saveStoredSessions(realSessions);
      }
      return realSessions;
    }
  } catch (e) {
    console.error('Failed to parse cached sessions:', e);
  }
  return [];
};

const saveStoredSessions = (sessions: ThreadSession[]) => {
  try {
    localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }
};

/**
 * 获取会话列表：尝试从 LangGraph Server 检索 threads，如果未连通则无缝 fallback 本地会话列表
 */
export async function getSessions(): Promise<{ sessions: ThreadSession[]; isLive: boolean }> {
  try {
    const client = createLangGraphClient();
    const threads = await client.threads.search({ limit: 20 });
    if (threads && Array.isArray(threads)) {
      const serverSessions: ThreadSession[] = threads.map(t => ({
        thread_id: t.thread_id,
        name: (t.metadata?.name as string) || `监测会话-${t.thread_id.slice(0, 6)}`,
        created_at: t.created_at || new Date().toISOString(),
        status: (t as any).status,
      }));
      // 若服务端暂无 threads，合并预置的原型数据展示
      if (serverSessions.length === 0) {
        return { sessions: loadStoredSessions(), isLive: true };
      }
      return { sessions: serverSessions, isLive: true };
    }
  } catch (err) {
    console.warn('LangGraph server not responding or offline, fallback to local sessions:', err);
  }
  return { sessions: loadStoredSessions(), isLive: false };
}

/**
 * 新建会话（Thread）
 */
export async function createSession(name?: string): Promise<ThreadSession> {
  const sessionName = name !== undefined ? name : '新建监测会话';
  try {
    const client = createLangGraphClient();
    const thread = await client.threads.create({
      metadata: { name: sessionName },
    });
    const newSession: ThreadSession = {
      thread_id: thread.thread_id,
      name: sessionName,
      created_at: new Date().toISOString(),
      messages: [],
    };
    const cached = loadStoredSessions();
    saveStoredSessions([newSession, ...cached]);
    return newSession;
  } catch (err) {
    console.warn('createSession using local fallback:', err);
    const newSession: ThreadSession = {
      thread_id: `thread-${Date.now()}`,
      name: sessionName,
      created_at: new Date().toISOString(),
      messages: [],
    };
    const cached = loadStoredSessions();
    saveStoredSessions([newSession, ...cached]);
    return newSession;
  }
}

/**
 * 根据用户首条消息生成会话标题
 * 优先调用 LangGraph Server 的 session-title 无状态图（设置超时）。
 * 若服务离线、调用异常或生成为空，优雅降级提取关键实体或截取首句，失败兜底为默认标题名。
 */
export async function generateSessionTitle(userMessage: string): Promise<string> {
  const DEFAULT_TITLE = '新会话';
  const cleanInput = userMessage?.trim();
  if (!cleanInput) return DEFAULT_TITLE;

  try {
    const client = createLangGraphClient();
    // 使用 Promise.race 设置 3.5 秒超时，避免阻塞用户感知
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Title generation timed out')), 3500)
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
      return null;
    })();

    const result = await Promise.race([runPromise, timeoutPromise]);
    if (result) return result;
  } catch (err) {
    console.warn('LangGraph title generator unavailable or failed, falling back:', err);
  }

  // 离线降级仅提取用户原句，不用“实体 + 固定动作”模板猜测意图。
  const normalized = cleanInput
    .replace(/[#*`\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstClause = normalized.split(/[。！？!?；;]/, 1)[0].trim();
  if (!firstClause) return DEFAULT_TITLE;
  if (firstClause.length <= 48) return firstClause;
  const stationMatch = firstClause.match(/[A-Z]{2,8}-[A-Z0-9-]{2,32}/i)?.[0] || '';
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (locale: string, options: { granularity: 'word' }) => {
      segment: (text: string) => Iterable<{ segment: string }>;
    };
  };
  const segments = IntlWithSegmenter.Segmenter
    ? Array.from(new IntlWithSegmenter.Segmenter('zh-CN', { granularity: 'word' }).segment(firstClause), (part) => part.segment)
    : firstClause.split(/(?<=[，,、：:\s])/);
  let shortened = '';
  for (const segment of segments) {
    if ((shortened + segment).length > 48) break;
    shortened += segment;
  }
  shortened = shortened.trim().replace(/[，,、：:]$/, '');
  if (stationMatch && !shortened.toLowerCase().includes(stationMatch.toLowerCase())) {
    return stationMatch.length <= 48 ? stationMatch : DEFAULT_TITLE;
  }
  return shortened || DEFAULT_TITLE;
}


/**
 * 重命名会话
 */
export async function renameSession(threadId: string, newName: string): Promise<void> {
  try {
    const client = createLangGraphClient();
    await client.threads.update(threadId, {
      metadata: { name: newName },
    });
  } catch (e) {
    console.warn('renameSession fallback:', e);
  }
  const cached = loadStoredSessions();
  const updated = cached.map(s => (s.thread_id === threadId ? { ...s, name: newName } : s));
  saveStoredSessions(updated);
}

/**
 * 删除会话
 */
export async function deleteSession(threadId: string): Promise<void> {
  try {
    const client = createLangGraphClient();
    await client.threads.delete(threadId);
  } catch (e) {
    console.warn('deleteSession fallback:', e);
  }
  const cached = loadStoredSessions();
  saveStoredSessions(cached.filter(s => s.thread_id !== threadId));
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
export function projectLangGraphMessages(rawMsgs: any[]): Message[] {
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
      const artifact = message.artifact || message.additional_kwargs?.artifact;
      const toolPart: MessagePart = {
        type: 'tool',
        toolCall: {
          id: callId || `tc-${result.length}-${pendingParts.length}`,
          name: message.name || existingTool?.name || 'beidou_tool',
          display_name: message.name || existingTool?.display_name || 'beidou_tool',
          status: message.status === 'error' ? 'error' : 'success',
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
          if (!call?.id || pendingParts.some((part) => part.type === 'tool' && part.toolCall.id === call.id)) continue;
          pendingParts.push({
            type: 'tool',
            toolCall: {
              id: call.id,
              name: call.name || 'beidou_tool',
              display_name: call.name || 'beidou_tool',
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
  flushAssistant('');
  return result;
}

/**
 * 获取单个会话的历史消息与历史压缩摘要：把 LangGraph state 的原始消息序列
 * （human / ai+tool_calls / tool / ai 文本）重构为前端的 parts 结构，
 * 工具结果以 tool part 形式挂在最终回答前，避免工具 JSON 被当成 AI 正文。
 * 若服务端已触发上下文压缩，contextSummary 携带持久化摘要供头部展示。
 */
export async function getSessionMessages(
  threadId: string
): Promise<{ messages: Message[]; contextSummary?: string; recommendations: string[] }> {
  // 先检查是否是预置会话
  const cached = loadStoredSessions();
  const found = cached.find(s => s.thread_id === threadId);

  try {
    const client = createLangGraphClient();
    const state = await client.threads.getState(threadId);
    if (state && state.values && Array.isArray((state.values as any).messages)) {
      const rawMsgs = (state.values as any).messages;
      const result = projectLangGraphMessages(rawMsgs);

      if (result.length > 0) {
        const contextSummary =
          typeof (state.values as any).context_summary === 'string' &&
          (state.values as any).context_summary.trim()
            ? (state.values as any).context_summary
            : undefined;
        // 下一步推荐动作随线程状态持久化，切换会话回来仍可恢复显示
        const recsRaw = (state.values as any).recommendations;
        const recommendations = Array.isArray(recsRaw)
          ? (recsRaw as any[])
              .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
              .slice(0, 3)
          : [];
        return { messages: result, contextSummary, recommendations };
      }
    }
  } catch (e) {
    console.warn('getSessionMessages fallback to cached:', e);
  }

  return { messages: found?.messages || [], recommendations: [] };
}
