import type { PartState, ToolCallMessagePartStatus } from '@assistant-ui/react';
import type {
  ConclusionsArtifactData,
  InvestigationStatus,
  StationArtifact,
  ToolArtifactEnvelope,
  ToolArtifactEnvelopeFor,
  ToolArtifactKind,
} from '@/types/envelope';
import { decodeToolArtifact, isToolFeedback } from './artifacts';
import { validCoordinates } from './coordinates';
import { evidenceNumbers } from './evidence-cards';

interface ToolPresentation {
  kind?: ToolArtifactKind;
  running: string;
  complete: string;
  failed: string;
  cancelled: string;
  emptyNotice: string;
}

export const CONCLUSIONS_TOOL_NAME = 'record_conclusions';

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  find_stations: {
    kind: 'station_list',
    running: '正在查询监测点…',
    complete: '已查询监测点',
    failed: '本次未取得测点信息',
    cancelled: '已取消查询监测点',
    emptyNotice: '未查询到符合条件的监测点。',
  },
  get_displacement: {
    kind: 'gnss_series',
    running: '正在获取位移数据…',
    complete: '已获取位移数据',
    failed: '本次未取得位移数据',
    cancelled: '已取消获取位移数据',
    emptyNotice: '该时间范围内暂无位移数据。',
  },
  get_station_history: {
    running: '正在读取以往调查结论…',
    complete: '已读取以往调查结论',
    failed: '以往调查结论未能读取',
    cancelled: '已取消读取以往结论',
    emptyNotice: '',
  },
  compute: {
    kind: 'computation',
    running: '正在计算…',
    complete: '已完成计算',
    failed: '计算未完成',
    cancelled: '已取消计算',
    emptyNotice: '',
  },
  [CONCLUSIONS_TOOL_NAME]: {
    kind: 'conclusions',
    running: '正在登记测点结论…',
    complete: '已登记测点结论',
    failed: '测点结论未登记',
    cancelled: '已取消登记结论',
    emptyNotice: '',
  },
  query_weather: {
    kind: 'weather',
    running: '正在查询天气…',
    complete: '已获取天气',
    failed: '本次未取得天气',
    cancelled: '已取消查询天气',
    emptyNotice: '未查询到符合条件的天气数据。',
  },
  inspect_site_environment: {
    kind: 'site_environment',
    running: '正在获取场地环境信息…',
    complete: '已获取场地环境信息',
    failed: '本次未取得场地信息',
    cancelled: '已取消调查场地环境',
    emptyNotice: '未取得可展示的场地环境信息。',
  },
};

const UNKNOWN_TOOL_PRESENTATION: ToolPresentation = {
  running: '正在获取辅助信息…',
  complete: '已完成辅助查询',
  failed: '本次未取得补充信息',
  cancelled: '已取消辅助查询',
  emptyNotice: '',
};

const presentationOf = (toolName: string) =>
  TOOL_PRESENTATIONS[toolName] ?? UNKNOWN_TOOL_PRESENTATION;

type Located<K extends ToolArtifactKind> = ToolArtifactEnvelopeFor<K> & { toolCallId: string };

export interface StationEvidence {
  id: string;
  uuid?: string;
  name: string;
  stationType?: string | null;
  status?: string | null;
  group?: string | null;
  /** WGS84 位置，来自测点资料或 GNSS 依据；用于在正文中绘制测点地图。 */
  coordinates?: { latitude: number; longitude: number };
  /** 位移序列，同时带有该窗口的数值特征。 */
  series: Located<'gnss_series'>[];
  weather: Located<'weather'>[];
  site: Located<'site_environment'>[];
}

type ToolCallLike = {
  type: 'tool-call';
  toolName: string;
  toolCallId: string;
  artifact?: unknown;
};

const isToolCall = <T extends { type: string }>(part: T): part is T & ToolCallLike =>
  part.type === 'tool-call';

const decodeToolPart = (part: ToolCallLike): ToolArtifactEnvelope | undefined => {
  if (typeof part.artifact === 'object' && part.artifact !== null && 'kind' in part.artifact
      && part.artifact.kind === 'acquisition_failure') {
    return decodeToolArtifact('acquisition_failure', part.artifact);
  }
  const kind = presentationOf(part.toolName).kind;
  return kind ? decodeToolArtifact(kind, part.artifact) : undefined;
};

const hasChartableData = (envelope: ToolArtifactEnvelope) => {
  if (envelope.kind === 'acquisition_failure') {
    return false;
  }
  if (envelope.kind === 'gnss_series') {
    return envelope.data.points.length > 0;
  }
  return true;
};

const stationNameOf = (envelope: ToolArtifactEnvelope): string | null => {
  switch (envelope.kind) {
    case 'acquisition_failure':
    case 'gnss_series':
      return envelope.data.station_name;
    case 'weather':
      return envelope.data.location.station_name ?? null;
    case 'site_environment':
      return envelope.data.center_station.station_name;
    default:
      return null;
  }
};

const stationUuidOf = (envelope: ToolArtifactEnvelope): string | null => {
  switch (envelope.kind) {
    case 'acquisition_failure':
    case 'gnss_series':
      return envelope.data.station_uuid || null;
    case 'weather':
      return envelope.data.location.station_uuid || null;
    case 'site_environment':
      return envelope.data.center_station.station_uuid || null;
    default:
      return null;
  }
};

const coordinatesOf = (
  location: { latitude?: number | null; longitude?: number | null } | null | undefined,
) => {
  if (!validCoordinates(location)) {
    return undefined;
  }
  return { latitude: location.latitude, longitude: location.longitude };
};

/** 依据按测点归集，而不是按工具调用顺序：用户核查的对象是测点。 */
export function collectStations(parts: readonly { type: string }[]): StationEvidence[] {
  const stations = new Map<string, StationEvidence>();
  const knownStations: StationArtifact[] = [];

  for (const part of parts) {
    if (!isToolCall(part)) continue;
    const envelope = decodeToolPart(part);
    if (!envelope) continue;

    if (envelope.kind === 'station_list') {
      knownStations.push(...envelope.data.stations);
      continue;
    }
    if (envelope.kind === 'site_environment') {
      knownStations.push(envelope.data.center_station, ...envelope.data.group_stations);
    }

    const name = stationNameOf(envelope);
    if (!name || !hasChartableData(envelope)) continue;

    const uuid = stationUuidOf(envelope);
    const id = uuid ?? 'evidence:' + part.toolCallId;
    let station = stations.get(id);
    if (!station) {
      station = { id, uuid: uuid ?? undefined, name, series: [], weather: [], site: [] };
      stations.set(id, station);
    }
    const toolCallId = part.toolCallId;
    switch (envelope.kind) {
      case 'gnss_series':
        station.series.push({ ...envelope, toolCallId });
        station.group = envelope.data.location?.group_name ?? station.group;
        station.coordinates = coordinatesOf(envelope.data.location) ?? station.coordinates;
        break;
      case 'weather':
        station.weather.push({ ...envelope, toolCallId });
        break;
      case 'site_environment':
        station.site.push({ ...envelope, toolCallId });
        break;
    }
  }

  for (const known of knownStations) {
    const station = known.station_uuid ? stations.get(known.station_uuid) : undefined;
    if (station) {
      station.status = known.station_status ?? station.status;
      station.stationType = known.station_type ?? station.stationType;
      station.group = known.group_name ?? station.group;
      station.coordinates = station.coordinates ?? coordinatesOf(known);
    }
  }
  return [...stations.values()];
}

export type StepState = 'running' | 'complete' | 'failed' | 'cancelled';

export interface InvestigationStep {
  toolCallId: string;
  evidenceId?: string;
  state: StepState;
  label: string;
  detail?: string;
  /** 工具正常结束但没有可展示内容时的说明。 */
  notice?: string;
  /** 能归到测点的步骤打开时间轴，其余结果在步骤内展开。 */
  stationName?: string;
  stationId?: string;
  inlineEnvelope?: ToolArtifactEnvelope;
  envelope?: ToolArtifactEnvelope;
}

const shortDate = (value: string) => value.slice(5, 10);

export const formatDateRange = (begin: string, end: string) =>
  `${shortDate(begin)} 至 ${shortDate(end)}`;

const stepDetail = (envelope: ToolArtifactEnvelope): string | undefined => {
  switch (envelope.kind) {
    case 'acquisition_failure':
      return envelope.data.station_name;
    case 'gnss_series':
      return `${envelope.data.station_name} · ${formatDateRange(envelope.data.begin_time, envelope.data.end_time)}`;
    case 'weather':
      return envelope.data.location.station_name ?? undefined;
    case 'site_environment':
      return envelope.data.center_station.station_name;
    case 'station_list':
      return `${envelope.data.total} 个测点`;
    case 'computation':
      return envelope.data.description;
    default:
      return undefined;
  }
};

type ToolPart = Extract<PartState, { type: 'tool-call' }>;

const stepStateOf = (part: ToolPart, envelope: ToolArtifactEnvelope | undefined): StepState => {
  const status = part.status as ToolCallMessagePartStatus;
  if (status.type === 'incomplete' && status.reason === 'cancelled') return 'cancelled';
  if (part.isError === true || envelope?.status === 'error' || status.type === 'incomplete') {
    return 'failed';
  }
  return status.type === 'complete' ? 'complete' : 'running';
};

/** 结论登记是留档，完成后只体现为测点状态标签。 */
const HIDDEN_WHEN_SETTLED = new Set([CONCLUSIONS_TOOL_NAME]);

/** 步骤状态只来自官方 tool part，不由前端推测进度。 */
export function buildSteps(
  parts: readonly PartState[],
  stations: readonly StationEvidence[],
): InvestigationStep[] {
  const stationIds = new Set(stations.map((station) => station.id));
  const steps: InvestigationStep[] = [];
  const successfulRequests = new Set<string>();

  // 只收起同工具、同参数且随后成功的尝试，不将其他时段或测点的成功当作恢复。
  for (const part of [...parts].reverse()) {
    if (part.type !== 'tool-call') continue;
    if (isToolFeedback(part.artifact)) continue;
    const presentation = presentationOf(part.toolName);
    const envelope = decodeToolPart(part);
    const state = stepStateOf(part, envelope);
    const requestKey = JSON.stringify([part.toolName, part.args]);
    if (state === 'failed' && successfulRequests.has(requestKey)) {
      continue;
    }
    if (state === 'complete') {
      successfulRequests.add(requestKey);
    }

    if (HIDDEN_WHEN_SETTLED.has(part.toolName) && state !== 'running') continue;

    // 仅供模型使用的工具答复（如基准站说明、以往结论）不进入用户可见的调查过程。
    if (state === 'complete' && part.artifact === null) continue;

    const name = envelope ? stationNameOf(envelope) : null;
    const identifier = envelope ? stationUuidOf(envelope) ?? 'evidence:' + part.toolCallId : undefined;
    const stationId = identifier && stationIds.has(identifier) ? identifier : undefined;
    const stationName = stationId ? name ?? undefined : undefined;
    const isEmpty = state === 'complete' && (!envelope || !hasChartableData(envelope));
    const label = {
      running: presentation.running,
      complete: presentation.complete,
      failed: presentation.failed,
      cancelled: presentation.cancelled,
    }[state];

    steps.push({
      toolCallId: part.toolCallId,
      evidenceId: envelope?.evidence_id,
      envelope,
      state,
      label,
      detail: envelope ? stepDetail(envelope) : undefined,
      notice: isEmpty ? presentation.emptyNotice || undefined : undefined,
      stationName,
      stationId,
      inlineEnvelope: envelope && !stationName && !isEmpty
        && (envelope.kind === 'station_list' || envelope.kind === 'weather' || envelope.kind === 'computation')
        ? envelope : undefined,
    });
  }
  return steps.reverse();
}

const latestArtifact = <K extends ToolArtifactKind>(
  parts: readonly { type: string }[],
  toolName: string,
  kind: K,
): ToolArtifactEnvelopeFor<K>['data'] | undefined => {
  for (const part of [...parts].reverse()) {
    if (!isToolCall(part) || part.toolName !== toolName) continue;
    const envelope = decodeToolArtifact(kind, part.artifact);
    if (envelope?.kind === kind && envelope.status !== 'error') {
      return envelope.data as ToolArtifactEnvelopeFor<K>['data'];
    }
  }
  return undefined;
};

/** 登记被拒绝时没有 artifact，只有通过校验的结论会被取到。 */
export const findConclusions = (parts: readonly { type: string }[]): ConclusionsArtifactData | undefined =>
  latestArtifact(parts, CONCLUSIONS_TOOL_NAME, 'conclusions');

export const STATUS_PRIORITY: Record<InvestigationStatus, number> = {
  需人工复核: 0,
  持续关注: 1,
  数据不足: 2,
  暂无法分析: 3,
  未见明显变化: 4,
};

export const investigationStatusLabel = (status: string): string =>
  status === '数据不足' || status === '暂无法分析' ? '数据待核查' : status;

const orderedConclusions = (conclusions: ConclusionsArtifactData) =>
  [...conclusions.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);

const hasRetainedEvidence = (step: InvestigationStep | undefined) =>
  Boolean(step?.envelope && (step.state === 'complete' || step.state === 'failed'));

/** 导出提供可读的来源与观测范围，不保留只能在当前页面打开的内部锚点。 */
export function evidenceDescription(step: InvestigationStep | undefined): string {
  const envelope = step?.envelope;
  if (!envelope || !hasRetainedEvidence(step)) {
    return '原始依据未随本次结果提供';
  }
  const details: string[] = [];
  if (envelope.observedAt) {
    details.push(`依据获取时间：${envelope.observedAt}`);
  }
  if (envelope.error) {
    details.push(`查询未完成：${envelope.error.message}`);
  }
  switch (envelope.kind) {
    case 'acquisition_failure':
      details.push(envelope.data.station_name, envelope.data.message);
      if (envelope.data.begin_time && envelope.data.end_time) {
        details.push(`${envelope.data.begin_time} 至 ${envelope.data.end_time}`);
      }
      break;
    case 'gnss_series':
      details.push(envelope.data.station_name, `${envelope.data.begin_time} 至 ${envelope.data.end_time}`);
      details.push(envelope.data.sampling?.mode === 'sample_times'
        ? `每日 ${(envelope.data.sampling.sample_times ?? []).join('、')} 采样`
        : '小时采样');
      break;
    case 'weather':
      details.push(envelope.data.location.station_name ?? '天气资料');
      details.push(`历史天气：${envelope.data.query.history_start_date} 至 ${envelope.data.query.history_end_date}`);
      if (envelope.data.current?.time) {
        details.push(`当前观测：${envelope.data.current.time}`);
      }
      if (envelope.data.forecast) {
        details.push(`含未来 ${envelope.data.query.forecast_days} 天预报，非历史实测`);
      }
      break;
    case 'site_environment':
      details.push(envelope.data.center_station.station_name, `场地快照：${envelope.data.observed_at}`);
      break;
    case 'computation':
      details.push(`计算：${envelope.data.description}`);
      details.push(...envelope.data.inputs.map((input) => `输入：${input.description}`));
      break;
    default:
      details.push(step?.detail ?? step?.label ?? '已保存的查询结果');
  }
  for (const source of envelope.sources ?? []) {
    const description = [source.name, source.provider, source.observed_at].filter(Boolean).join(' · ');
    if (description) {
      details.push(description);
    }
    if (source.url && /^https?:\/\//.test(source.url)) {
      details.push(source.url);
    }
  }
  details.push(...(envelope.limitations ?? []));
  return [...new Set(details)].join('；');
}

/** 模型只登记了结论、没有写正文时，用结论补出可读文本。 */
export function conclusionsToMarkdown(conclusions: ConclusionsArtifactData): string {
  return orderedConclusions(conclusions)
    .map((station) => `## ${station.station_name} · ${investigationStatusLabel(station.status)}\n\n${station.reason}（${station.begin_time} 至 ${station.end_time}）`)
    .join('\n\n');
}

export function answerToMarkdown(parts: readonly PartState[]): string {
  const steps = buildSteps(parts, collectStations(parts));
  const conclusions = findConclusions(parts);
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n').trim();
  if (!text) {
    return conclusions ? conclusionsToMarkdown(conclusions) : '';
  }
  const numbers = evidenceNumbers(text);
  const cited = new Map<string, number>();
  const body = text.replace(/\[([^\]]+)\]\(#evidence-([A-Za-z0-9]+)\)/g, (_match, label: string, id: string) => {
    const step = steps.find((item) => item.evidenceId === id && hasRetainedEvidence(item));
    if (!step) {
      return '（原始依据未随本次结果提供）';
    }
    if (!cited.has(id)) {
      cited.set(id, numbers.get(id)!);
    }
    return `[${cited.get(id)}]`;
  });
  const sections: string[] = [];
  if (conclusions && conclusions.stations.length > 0) {
    const statuses = orderedConclusions(conclusions)
      .map((station) => `${station.station_name}：${investigationStatusLabel(station.status)}`);
    sections.push(`测点状态：${statuses.join('；')}`);
  }
  sections.push(body);
  if (cited.size > 0) {
    const evidence = [...cited].map(([id, number]) => `[${number}] ${evidenceDescription(steps.find((step) => step.evidenceId === id))}`);
    sections.push(`## 依据\n\n${evidence.join('\n\n')}`);
  }
  return sections.join('\n\n');
}
