import type { LangChainMessage, LangGraphMessagesEvent } from '@assistant-ui/react-langgraph';
import type { GnssArtifactData } from '@/types/envelope';
import type { AskTargetRecord } from '@/features/monitoring/ask-targets';
import { BytesLineDecoder, IterableReadableStream, SSEDecoder } from '@langchain/langgraph-sdk/utils';

const STORAGE_KEY_CONFIG = 'lma_api_url';
const DEFAULT_API_URL = '/api';

export interface Session {
  id: string;
  name: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface SessionState {
  values: { messages: LangChainMessage[] };
  latest_run: { status: string } | null;
}

export type Screening = '建议调查' | '未见明显变化' | '数据不足' | '暂无法分析';

/** 结构化初筛线索，与后端 inspection/screening.py 的 Finding 一致。 */
export interface ScreeningFinding {
  kind: 'trend' | 'acceleration' | 'gap_jump' | 'tail_step' | 'held_step' | 'spike' | 'gap' | 'data';
  role: 'trigger' | 'quality';
  text: string;
  axis: 'n' | 'e' | 'u' | null;
  window: 'long' | 'recent' | null;
  value_mm: number | null;
  days: number | null;
}

export interface InspectionStation {
  station_uuid: string;
  station_name: string;
  group_name: string;
  screening: Screening;
  reasons: string[];
  findings: ScreeningFinding[];
  metrics: { net_change_mm?: Partial<Record<'n' | 'e' | 'u', number>> };
  trend: Array<number | null>;
  previous_screening: Screening | null;
  last_conclusion: { status: string; reason: string; session_id: string; created_at: string } | null;
}

export interface LatestInspection {
  running: { total_stations: number; completed_stations: number } | null;
  latest_attempt: {
    id: string;
    status: 'running' | 'success' | 'error' | 'interrupted';
    finished_at: string | null;
    total_stations: number;
    completed_stations: number;
  } | null;
  inspection: { id: string; finished_at: string } | null;
  stations: InspectionStation[];
}

export type TimelineDays = 7 | 30 | 90;

export interface StationDirectoryEntry {
  station_uuid: string;
  station_name: string;
  group_name: string;
}

export interface StationRecord {
  validated?: boolean;
  historical_status?: string | null;
  anchor_id: string;
  session_id: string;
  session_name: string;
  status: string | null;
  reason: string;
  created_at: string;
}

export interface StationTimeline {
  station_uuid: string;
  station_name: string;
  group_name: string;
  /** 基准站等没有形变序列的测点为 null。 */
  series: GnssArtifactData | null;
  records: StationRecord[];
}

/** 测点页的逐日降雨与强降雨前后位移速率（服务端 app/rainfall.py）。 */
export interface RainEvent {
  start: string;
  end: string;
  total_mm: number;
  peak_mm: number;
  antecedent_7d_mm: number | null;
  axis: 'n' | 'e' | 'u' | null;
  axis_name: string | null;
  rate_before_mm_day: number | null;
  rate_after_mm_day: number | null;
}

export interface StationRainfall {
  daily: Array<{ date: string; value: number | null }>;
  events: RainEvent[];
  threshold_mm: number;
  source: { name: string; url: string };
  limitations: string[];
}

export interface SessionConclusion {
  session_id: string;
  station_name: string;
  status: string;
}

export type LabScope =
  | { kind: 'all' }
  | { kind: 'group'; group_uuid: string }
  | { kind: 'station'; station_uuid: string };

export interface LabScopeGroup {
  group_uuid: string;
  group_name: string;
  stations: Array<{ station_uuid: string; station_name: string }>;
}

export interface LabInspection {
  id: string;
  label: string;
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
  created_at: string;
  finished_at: string | null;
}

/** LangGraph push_ui_message 的组件消息；props 由各组件自行校验。 */
export interface LabUIMessage {
  type: 'ui';
  id: string;
  name: string;
  props: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LabState {
  values: { messages: LangChainMessage[]; ui: LabUIMessage[] };
  status: LabInspection['status'];
}

export const getStoredApiUrl = () => {
  if (import.meta.env.PROD) return DEFAULT_API_URL;
  return localStorage.getItem(STORAGE_KEY_CONFIG) || DEFAULT_API_URL;
};

export const setStoredApiUrl = (url: string) => {
  if (!import.meta.env.PROD) localStorage.setItem(STORAGE_KEY_CONFIG, url);
};

/** 任一接口返回 401（未登录或登录过期）时广播，由应用入口切回登录页。 */
export const UNAUTHORIZED_EVENT = 'lma:unauthorized';

export interface AuthSession {
  enabled: boolean;
  authenticated: boolean;
}

export class LmaClient {
  constructor(private readonly apiUrl: string) {}

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (response.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(typeof error?.detail === 'string' ? error.detail : `服务请求失败（HTTP ${response.status}）。`);
    }
    return response;
  }

  async getAuthSession(): Promise<AuthSession> {
    return (await this.request('/auth/session', { signal: AbortSignal.timeout(10000) })).json();
  }

  /** 账号或密码错误时抛出服务端的中文说明；登录接口的 401 不广播为“登录过期”。 */
  async login(username: string, password: string): Promise<void> {
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(typeof error?.detail === 'string' ? error.detail : `登录失败（HTTP ${response.status}）。`);
    }
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' });
  }

  async health(): Promise<{ ok: boolean; service: string }> {
    const response = await this.request('/health', { signal: AbortSignal.timeout(10000) });
    return response.json();
  }

  async listSessions(params: { limit: number; offset: number; stationUuid?: string; search?: string }, signal?: AbortSignal): Promise<Session[]> {
    const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.stationUuid) {
      query.set('station_uuid', params.stationUuid);
    }
    if (params.search) {
      query.set('search', params.search);
    }
    return (await this.request(`/sessions?${query}`, { signal })).json();
  }

  async createSession(stationUuid?: string): Promise<Session> {
    return (await this.request('/sessions', { method: 'POST', body: JSON.stringify({ name: '新会话', station_uuid: stationUuid }) })).json();
  }

  async getSession(id: string): Promise<Session> {
    return (await this.request(`/sessions/${encodeURIComponent(id)}`)).json();
  }

  async updateSession(id: string, fields: { name?: string; archived?: boolean }): Promise<Session> {
    return (await this.request(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(fields) })).json();
  }

  async deleteSession(id: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getState(id: string, signal?: AbortSignal): Promise<SessionState> {
    return (await this.request(`/sessions/${encodeURIComponent(id)}/state`, { signal })).json();
  }

  async findCheckpoint(id: string, messages: LangChainMessage[]): Promise<string> {
    const response = await this.request(`/sessions/${encodeURIComponent(id)}/checkpoint`, {
      method: 'POST', body: JSON.stringify({ message_ids: messages.map((message) => message.id) }),
    });
    return (await response.json()).checkpoint_id;
  }

  async getMapConfig(): Promise<{ amap_token: string | null }> {
    return (await this.request('/map-config', { signal: AbortSignal.timeout(10000) })).json();
  }

  async generateTitle(inputText: string): Promise<string> {
    const response = await this.request('/title', {
      method: 'POST', body: JSON.stringify({ input_text: inputText }), signal: AbortSignal.timeout(20000),
    });
    return (await response.json()).title;
  }

  async suggestQuestions(): Promise<string[]> {
    const response = await this.request('/suggestions', {
      method: 'POST', signal: AbortSignal.timeout(20000),
    });
    return (await response.json()).questions;
  }

  async getLatestInspection(signal?: AbortSignal): Promise<LatestInspection> {
    return (await this.request('/inspections/latest', { signal })).json();
  }

  async startInspection(): Promise<void> {
    await this.request('/inspections', { method: 'POST' });
  }

  async getStationTimeline(stationUuid: string, days: TimelineDays, signal?: AbortSignal): Promise<StationTimeline> {
    const path = `/stations/${encodeURIComponent(stationUuid)}/timeline?days=${days}`;
    return (await this.request(path, { signal })).json();
  }

  async getStationRainfall(stationUuid: string, days: TimelineDays, signal?: AbortSignal): Promise<StationRainfall> {
    const path = `/stations/${encodeURIComponent(stationUuid)}/rainfall?days=${days}`;
    return (await this.request(path, { signal })).json();
  }

  async listStations(signal?: AbortSignal): Promise<StationDirectoryEntry[]> {
    return (await this.request('/stations', { signal })).json();
  }

  async listSessionConclusions(signal?: AbortSignal): Promise<SessionConclusion[]> {
    return (await this.request('/sessions/conclusions', { signal })).json();
  }

  async cancelRun(id: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  async listLabScopes(signal?: AbortSignal): Promise<LabScopeGroup[]> {
    return (await (await this.request('/lab/scopes', { signal })).json()).groups;
  }

  async listLabInspections(signal?: AbortSignal): Promise<LabInspection[]> {
    return (await this.request('/lab/inspections', { signal })).json();
  }

  async createLabInspection(): Promise<LabInspection> {
    return (await this.request('/lab/inspections', { method: 'POST' })).json();
  }

  async getLabInspection(id: string): Promise<LabInspection> {
    return (await this.request(`/lab/inspections/${encodeURIComponent(id)}`)).json();
  }

  async getLabState(id: string, signal?: AbortSignal): Promise<LabState> {
    return (await this.request(`/lab/inspections/${encodeURIComponent(id)}/state`, { signal })).json();
  }

  async *streamLabRun(
    id: string,
    messages: LangChainMessage[],
    scope: LabScope,
    signal: AbortSignal,
  ): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
    const response = await this.request(`/lab/inspections/${encodeURIComponent(id)}/runs`, {
      method: 'POST', body: JSON.stringify({ messages, scope }), signal,
    });
    yield* readRunEvents(response);
  }

  /** 刷新后接回仍在进行的原型巡检；没有进行中的巡检时直接结束。 */
  async *joinLabRun(id: string, signal: AbortSignal): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
    const response = await this.request(`/lab/inspections/${encodeURIComponent(id)}/runs/active`, { signal });
    if (response.status === 204) return;
    yield* readRunEvents(response);
  }

  async cancelLabRun(id: string): Promise<void> {
    await this.request(`/lab/inspections/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  async *streamRun(
    id: string,
    messages: LangChainMessage[],
    options: { checkpointId?: string; focusStation?: string; askTargets: readonly AskTargetRecord[]; signal: AbortSignal },
  ): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
    try {
      const response = await this.request(`/sessions/${encodeURIComponent(id)}/runs`, {
        method: 'POST', body: JSON.stringify({
          messages,
          checkpoint_id: options.checkpointId,
          focus_station: options.focusStation,
          ask_targets: options.askTargets,
        }),
        signal: options.signal,
      });
      yield* readRunEvents(response);
    } finally {
      if (options.signal.aborted) await this.cancelRun(id);
    }
  }

  /** 刷新或重新打开会话后接回服务端仍在进行的调查；没有进行中的调查时直接结束。 */
  async *joinRun(id: string, signal: AbortSignal): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
    try {
      const response = await this.request(`/sessions/${encodeURIComponent(id)}/runs/active`, { signal });
      if (response.status === 204) return;
      yield* readRunEvents(response);
    } finally {
      if (signal.aborted) await this.cancelRun(id);
    }
  }
}

async function* readRunEvents(response: Response): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
  if (!response.body) throw new Error('服务未返回消息流。');
  const events = response.body.pipeThrough(BytesLineDecoder()).pipeThrough(SSEDecoder());
  for await (const event of IterableReadableStream.fromReadableStream(events)) {
    yield { event: event.event, data: event.data };
  }
}

export const createLmaClient = (apiUrl: string) => new LmaClient(apiUrl);
