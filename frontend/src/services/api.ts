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
          return title.trim().replace(/^["'“”]+|["'“”]+$/g, '').slice(0, 16);
        }
      }
      return null;
    })();

    const result = await Promise.race([runPromise, timeoutPromise]);
    if (result) return result;
  } catch (err) {
    console.warn('LangGraph title generator unavailable or failed, falling back:', err);
  }

  // 降级规则：
  // 1. 若包含站点名（如 ZJ-MS10, SX-01 等），结合意图词
  const stationMatch = cleanInput.match(/[A-Z]{2}-[A-Z0-9]{2,6}/i);
  const station = stationMatch ? stationMatch[0].toUpperCase() : '';

  if (station) {
    if (cleanInput.includes('稳定')) return `${station}稳定性分析`;
    if (cleanInput.includes('天气') || cleanInput.includes('降雨') || cleanInput.includes('气象')) {
      return `${station}气象与环境`;
    }
    if (cleanInput.includes('数据') || cleanInput.includes('GNSS')) {
      return `${station}数据监测`;
    }
    return `${station}监测分析`;
  }

  if (cleanInput.includes('天气') || cleanInput.includes('降雨') || cleanInput.includes('气温')) {
    const locMatch = cleanInput.match(/([\u4e00-\u9fa5]{2,6})(?:今日|近期|天气|降雨)/);
    const loc = locMatch ? locMatch[1] : '';
    return loc ? `${loc}天气查询` : '气象环境查询';
  }

  if (
    cleanInput.includes('分组') ||
    cleanInput.includes('测点') ||
    cleanInput.includes('点位') ||
    cleanInput.includes('站点数量')
  ) {
    return '监测点资源统计';
  }

  // 2. 普通文本截取前 12 字符
  const textSample = cleanInput
    .replace(/[#*`\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);

  return textSample || DEFAULT_TITLE;
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

/**
 * 获取单个会话的历史消息与历史压缩摘要：把 LangGraph state 的原始消息序列
 * （human / ai+tool_calls / tool / ai 文本）重构为前端的 parts 结构，
 * 工具结果以 tool part 形式挂在最终回答前，避免工具 JSON 被当成 AI 正文。
 * 若服务端已触发上下文压缩，contextSummary 携带持久化摘要供头部展示。
 */
export async function getSessionMessages(
  threadId: string
): Promise<{ messages: Message[]; contextSummary?: string }> {
  // 先检查是否是预置会话
  const cached = loadStoredSessions();
  const found = cached.find(s => s.thread_id === threadId);

  try {
    const client = createLangGraphClient();
    const state = await client.threads.getState(threadId);
    if (state && state.values && Array.isArray((state.values as any).messages)) {
      const rawMsgs = (state.values as any).messages;
      const result: Message[] = [];
      let pendingParts: MessagePart[] = [];

      const parseDetail = (content: any): Record<string, unknown> | undefined => {
        if (typeof content !== 'string') return undefined;
        try {
          return JSON.parse(content);
        } catch {
          return undefined;
        }
      };

      const flushAssistant = (text: string) => {
        if (pendingParts.length > 0) {
          const parts: MessagePart[] = [...pendingParts];
          if (text.trim()) parts.push({ type: 'text', content: text });
          result.push({ role: 'assistant', content: text, parts });
        } else if (text.trim()) {
          result.push({ role: 'assistant', content: text });
        }
        pendingParts = [];
      };

      for (const m of rawMsgs) {
        const text = typeof m.content === 'string' ? m.content : '';

        if (m.type === 'human') {
          flushAssistant('');
          result.push({ id: m.id, role: 'user', content: text });
        } else if (m.type === 'tool') {
          // 工具结果：折叠为 tool part，等最终回答时一并展示
          pendingParts.push({
            type: 'tool',
            toolCall: {
              id: m.tool_call_id || m.id || `tc-${result.length}-${pendingParts.length}`,
              name: m.name || 'beidou_tool',
              display_name: m.name || 'beidou_tool',
              status: 'success',
              detail: parseDetail(m.content),
              images: Array.isArray((m as any)?.artifact?.images)
                ? (m as any).artifact.images.filter(
                    (img: any) => img?.name && typeof img?.png_base64 === 'string'
                  )
                : undefined,
              chartPoints: Array.isArray((m as any)?.artifact?.chart_points)
                ? ((m as any).artifact.chart_points as ChartPoint[])
                : undefined,
            },
          });
        } else if (m.type === 'ai') {
          const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if (hasToolCalls) {
            // 发起工具调用的中间轮：正文通常为空，若带文本则作为片段保留
            if (text.trim()) pendingParts.push({ type: 'text', content: text });
          } else if (text.trim()) {
            // 最终回答：与前置工具卡片合并为一条带 parts 的消息
            flushAssistant(text);
          }
        }
      }
      flushAssistant('');

      if (result.length > 0) {
        const contextSummary =
          typeof (state.values as any).context_summary === 'string' &&
          (state.values as any).context_summary.trim()
            ? (state.values as any).context_summary
            : undefined;
        return { messages: result, contextSummary };
      }
    }
  } catch (e) {
    console.warn('getSessionMessages fallback to cached:', e);
  }

  return { messages: found?.messages || [] };
}

export interface StreamChatCallbacks {
  onToken: (token: string) => void;
  onToolStart?: (toolName: string, input?: any) => void;
  onToolEnd?: (toolName: string, output?: any) => void;
  onPartsUpdate?: (parts: MessagePart[]) => void;
  onError?: (err: any) => void;
  onDone?: (fullText: string, finalParts?: MessagePart[]) => void;
}

/**
 * 向 LangGraph Server 发起 Runs Stream 流式对话
 */
export async function streamChatWithLangGraph(
  threadId: string,
  userMessage: string,
  callbacks: StreamChatCallbacks,
  signal?: AbortSignal
): Promise<string> {
  const client = createLangGraphClient();
  const assistantId = 'lma-agent';

  let accumulated = '';
  let hasReceivedTokens = false;
  const currentParts: MessagePart[] = [];

  const addOrUpdateTool = (
    toolName: string,
    input?: any,
    output?: any,
    isEnd: boolean = false,
    images?: ToolCallImage[],
    callId?: string,
    chartPoints?: ChartPoint[]
  ) => {
    // 以 tool_call_id 为主键去重：同一调用只保留一张卡，重复事件只更新
    let existingIndex = callId
      ? currentParts.findIndex(
          (p) => p.type === 'tool' && p.toolCall.id === callId
        )
      : -1;
    if (existingIndex < 0) {
      existingIndex = currentParts.findIndex(
        (p) => p.type === 'tool' && p.toolCall.name === toolName && p.toolCall.status === 'loading'
      );
    }
    if (existingIndex >= 0 && currentParts[existingIndex].type === 'tool') {
      const tc = (currentParts[existingIndex] as { type: 'tool'; toolCall: ToolCallInfo }).toolCall;
      if (isEnd) {
        tc.status = 'success';
        if (output !== undefined) tc.detail = output;
        if (images) tc.images = images;
        if (chartPoints) tc.chartPoints = chartPoints;
      }
    } else {
      currentParts.push({
        type: 'tool',
        toolCall: {
          id: callId || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: toolName,
          display_name: toolName,
          status: isEnd ? 'success' : 'loading',
          input,
          detail: output,
          images,
          chartPoints,
        },
      });
    }
    callbacks.onPartsUpdate?.([...currentParts]);
  };

  const appendTextToken = (token: string) => {
    if (!token) return;
    hasReceivedTokens = true;
    accumulated += token;
    const last = currentParts[currentParts.length - 1];
    if (last && last.type === 'text') {
      last.content += token;
    } else {
      currentParts.push({ type: 'text', content: token });
    }
    callbacks.onPartsUpdate?.([...currentParts]);
    callbacks.onToken(token);
  };

  try {
    const stream = client.runs.stream(
      threadId,
      assistantId,
      {
        input: {
          messages: [{ role: 'user', content: userMessage }],
        },
        streamMode: ['messages-tuple', 'updates'],
        signal,
      }
    );

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      // 按照官方规范解析 messages-tuple 流模式
      if (chunk.event === 'messages') {
        const [msg, meta] = chunk.data as [any, any];

        // 1. 工具节点输出（ToolMessage）：工具调用结果，嵌入当前流式消息块中；
        //    artifact（如视觉复核渲染的图表 PNG）随 ToolMessage 转发，不进入 LLM 上下文。
        //    注意：不能仅凭 meta.langgraph_node === 'tools' 判断——工具内部调用
        //    的 LLM（如视觉模型）token 流同样来自 tools 节点，会被误判成工具结果
        //    导致重复建卡刷屏；必须确认消息本体就是 ToolMessage
        const isToolResult =
          msg?.type === 'tool' || msg?.type === 'ToolMessage' || msg?.role === 'tool';
        if (isToolResult) {
          const callId: string | undefined = msg?.tool_call_id || msg?.id;
          const artifactImages: ToolCallImage[] | undefined = Array.isArray(
            (msg as any)?.artifact?.images
          )
            ? (msg as any).artifact.images.filter(
                (img: any) => img?.name && typeof img?.png_base64 === 'string'
              )
            : undefined;
          const artifactChartPoints: ChartPoint[] | undefined = Array.isArray(
            (msg as any)?.artifact?.chart_points
          )
            ? (msg as any).artifact.chart_points
            : undefined;
          // 同一 tool_call_id 已有卡片时用其工具名，避免 name 缺失时退化成 beidou_tool
          let toolName = msg?.name;
          if (!toolName && callId) {
            const existing = currentParts.find(
              (p) => p.type === 'tool' && p.toolCall.id === callId
            );
            toolName = existing?.type === 'tool' ? existing.toolCall.name : undefined;
          }
          callbacks.onToolEnd?.(toolName || 'beidou_tool', msg?.content);
          addOrUpdateTool(
            toolName || 'beidou_tool',
            undefined,
            msg?.content,
            true,
            artifactImages,
            callId,
            artifactChartPoints
          );
          continue;
        }

        // 工具内部 LLM 调用（如视觉模型）的 token 也走 messages 事件，
        // 只处理 agent 节点产生的 AI 消息，其余一律忽略
        const node = meta?.langgraph_node;
        if (node && node !== 'agent') continue;

        // 2. 检查智能体是否在发起工具调用（tool_call_chunks）
        if (msg?.tool_call_chunks && Array.isArray(msg.tool_call_chunks) && msg.tool_call_chunks.length > 0) {
          for (const tc of msg.tool_call_chunks) {
            if (tc?.name) {
              callbacks.onToolStart?.(tc.name, tc.args);
              addOrUpdateTool(tc.name, tc.args, undefined, false, undefined, tc.id);
            }
          }
        }

        // 3. AI 智能体生成的正文文本 Token（AIMessageChunk）
        if (typeof msg?.content === 'string' && msg.content.length > 0) {
          appendTextToken(msg.content);
        }
      }
      // updates 事件不再渲染工具卡片：messages-tuple 已携带完整 ToolMessage 结果，
      // 在此重复渲染会导致同一工具的原始数据展示第二遍
    }

    if (hasReceivedTokens || accumulated.trim().length > 0 || currentParts.length > 0) {
      callbacks.onDone?.(accumulated, currentParts);
      return accumulated;
    }
  } catch (err: any) {
    if (signal?.aborted) return accumulated;
    console.warn('streamChatWithLangGraph server stream failed:', err);
    callbacks.onError?.(err);
    throw err;
  }

  if (!hasReceivedTokens && accumulated.trim().length === 0 && currentParts.length === 0) {
    const noReplyErr = new Error('智能体未返回任何有效内容，请检查后端服务日志并重试');
    callbacks.onError?.(noReplyErr);
    throw noReplyErr;
  }

  callbacks.onDone?.(accumulated, currentParts);
  return accumulated;
}
