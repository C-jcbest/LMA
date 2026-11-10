import type { LangChainMessage, LangGraphMessagesEvent } from '@assistant-ui/react-langgraph';
import type { GnssArtifactData } from '@/types/envelope';
import { BytesLineDecoder, IterableReadableStream, SSEDecoder } from '@langchain/langgraph-sdk/utils';

const STORAGE_KEY_CONFIG = 'lma_api_url';
const DEFAULT_API_URL = '/api';

export interface InvestigationRecord {
  id: string;
  status: string;
  progress: {
    goal: string;
    targets: Array<{ target_id: string; station_uuid: string; question: string; begin_time: string; end_time: string; evidence_ids: string[] }>;
    covered: string[];
    unresolved: string[];
    stage_conclusion: string;
  };
}

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

export interface InspectionStation {
  station_uuid: string;
  station_name: string;
  group_name: string;
  screening: Screening;
  reasons: string[];
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

export interface SessionConclusion {
  session_id: string;
  station_name: string;
  status: string;
}

export const getStoredApiUrl = () => {
  if (import.meta.env.PROD) return DEFAULT_API_URL;
  return localStorage.getItem(STORAGE_KEY_CONFIG) || DEFAULT_API_URL;
};

export const setStoredApiUrl = (url: string) => {
  if (!import.meta.env.PROD) localStorage.setItem(STORAGE_KEY_CONFIG, url);
};

export class LmaClient {
  constructor(private readonly apiUrl: string) {}

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(typeof error?.detail === 'string' ? error.detail : `服务请求失败（HTTP ${response.status}）。`);
    }
    return response;
  }

  async health(): Promise<{ ok: boolean; service: string }> {
    const response = await this.request('/health', { signal: AbortSignal.timeout(10000) });
    return response.json();
  }

  async listSessions(params: { limit: number; offset: number; stationUuid?: string }): Promise<Session[]> {
    const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.stationUuid) {
      query.set('station_uuid', params.stationUuid);
    }
    return (await this.request(`/sessions?${query}`)).json();
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

  async listInvestigations(id: string, signal?: AbortSignal): Promise<InvestigationRecord[]> {
    return (await this.request(`/sessions/${encodeURIComponent(id)}/investigations`, { signal })).json();
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

  async generateTitle(inputText: string): Promise<string> {
    const response = await this.request('/title', {
      method: 'POST', body: JSON.stringify({ input_text: inputText }), signal: AbortSignal.timeout(20000),
    });
    return (await response.json()).title;
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

  async listStations(signal?: AbortSignal): Promise<StationDirectoryEntry[]> {
    return (await this.request('/stations', { signal })).json();
  }

  async listSessionConclusions(signal?: AbortSignal): Promise<SessionConclusion[]> {
    return (await this.request('/sessions/conclusions', { signal })).json();
  }

  async cancelRun(id: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  async *streamRun(
    id: string,
    messages: LangChainMessage[],
    options: { checkpointId?: string; focusStation?: string; resumeInvestigationId?: string; signal: AbortSignal },
  ): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
    try {
      const response = await this.request(`/sessions/${encodeURIComponent(id)}/runs`, {
        method: 'POST', body: JSON.stringify({ messages, checkpoint_id: options.checkpointId, focus_station: options.focusStation, resume_investigation_id: options.resumeInvestigationId }),
        signal: options.signal,
      });
      if (!response.body) throw new Error('服务未返回消息流。');
      const events = response.body.pipeThrough(BytesLineDecoder()).pipeThrough(SSEDecoder());
      for await (const event of IterableReadableStream.fromReadableStream(events)) {
        yield { event: event.event, data: event.data };
      }
    } finally {
      if (options.signal.aborted) await this.cancelRun(id);
    }
  }
}

export const createLmaClient = (apiUrl: string) => new LmaClient(apiUrl);
