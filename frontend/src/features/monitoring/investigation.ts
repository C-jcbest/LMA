import type { PartState, ToolCallMessagePartStatus } from '@assistant-ui/react';
import type {
  FindingLevel,
  InvestigationReportArtifactData,
  InvestigationStatus,
  StationArtifact,
  ToolArtifactEnvelope,
  ToolArtifactEnvelopeFor,
  ToolArtifactKind,
} from '@/types/envelope';
import { decodeToolArtifact } from './artifacts';

interface ToolPresentation {
  kind?: ToolArtifactKind;
  running: string;
  complete: string;
  failed: string;
  cancelled: string;
  emptyNotice: string;
}

const STATION_LIST_EMPTY = '未查询到符合条件的监测点。';

export const REPORT_TOOL_NAME = 'submit_investigation_report';

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  [REPORT_TOOL_NAME]: {
    kind: 'investigation_report',
    running: '正在整理调查简报…',
    complete: '已完成调查简报',
    failed: '调查简报未通过校验',
    cancelled: '已取消整理调查简报',
    emptyNotice: '',
  },
  list_station_groups: {
    kind: 'station_list',
    running: '正在查询监测点分组…',
    complete: '已查询监测点分组',
    failed: '监测点分组查询失败',
    cancelled: '已取消查询监测点分组',
    emptyNotice: '未查询到符合条件的监测点分组。',
  },
  list_stations: {
    kind: 'station_list',
    running: '正在查询监测点信息…',
    complete: '已查询监测点信息',
    failed: '监测点信息查询失败',
    cancelled: '已取消查询监测点信息',
    emptyNotice: STATION_LIST_EMPTY,
  },
  get_daily_gnss_data: {
    kind: 'gnss_series',
    running: '正在获取 GNSS 监测数据…',
    complete: '已获取 GNSS 监测数据',
    failed: 'GNSS 数据获取失败',
    cancelled: '已取消获取 GNSS 监测数据',
    emptyNotice: '该时间范围内暂无 GNSS 数据。',
  },
  query_weather: {
    kind: 'weather',
    running: '正在查询同期天气…',
    complete: '已获取同期天气',
    failed: '天气数据查询失败',
    cancelled: '已取消查询天气',
    emptyNotice: '未查询到符合条件的天气数据。',
  },
  analyze_gnss_chart: {
    kind: 'vision',
    running: '正在复核位移曲线…',
    complete: '已完成位移曲线复核',
    failed: '位移曲线复核失败',
    cancelled: '已取消复核位移曲线',
    emptyNotice: '该时间范围内暂无可供复核的 GNSS 数据。',
  },
  inspect_site_environment: {
    kind: 'site_environment',
    running: '正在获取场地环境信息…',
    complete: '已获取场地环境信息',
    failed: '场地环境信息获取失败',
    cancelled: '已取消调查场地环境',
    emptyNotice: '未取得可展示的场地环境信息。',
  },
};

const UNKNOWN_TOOL_PRESENTATION: ToolPresentation = {
  running: '正在获取辅助信息…',
  complete: '已完成辅助查询',
  failed: '辅助查询失败',
  cancelled: '已取消辅助查询',
  emptyNotice: '',
};

const presentationOf = (toolName: string) =>
  TOOL_PRESENTATIONS[toolName] ?? UNKNOWN_TOOL_PRESENTATION;

type Located<K extends ToolArtifactKind> = ToolArtifactEnvelopeFor<K> & { toolCallId: string };

export interface StationEvidence {
  name: string;
  status?: string | null;
  group?: string | null;
  series: Located<'gnss_series'>[];
  weather: Located<'weather'>[];
  vision: Located<'vision'>[];
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
  const kind = presentationOf(part.toolName).kind;
  return kind ? decodeToolArtifact(kind, part.artifact) : undefined;
};

const hasChartableData = (envelope: ToolArtifactEnvelope) => {
  if (envelope.kind === 'gnss_series') {
    return envelope.data.points.length > 0;
  }
  if (envelope.kind === 'vision') {
    return envelope.data.images.length > 0 || envelope.data.chart_points.length > 0;
  }
  return true;
};

const stationNameOf = (envelope: ToolArtifactEnvelope): string | null => {
  switch (envelope.kind) {
    case 'gnss_series':
    case 'vision':
      return envelope.data.station_name;
    case 'weather':
      return envelope.data.location.station_name ?? null;
    case 'site_environment':
      return envelope.data.center_station.station_name;
    case 'station_list':
    case 'investigation_report':
      return null;
  }
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
      knownStations.push(...(envelope.data.stations ?? []));
      continue;
    }
    if (envelope.kind === 'site_environment') {
      knownStations.push(envelope.data.center_station, ...envelope.data.group_stations);
    }

    if (envelope.kind === 'investigation_report') continue;

    const name = stationNameOf(envelope);
    if (!name || !hasChartableData(envelope)) continue;

    let station = stations.get(name);
    if (!station) {
      station = { name, series: [], weather: [], vision: [], site: [] };
      stations.set(name, station);
    }
    const toolCallId = part.toolCallId;
    switch (envelope.kind) {
      case 'gnss_series':
        station.series.push({ ...envelope, toolCallId });
        break;
      case 'weather':
        station.weather.push({ ...envelope, toolCallId });
        break;
      case 'vision':
        station.vision.push({ ...envelope, toolCallId });
        break;
      case 'site_environment':
        station.site.push({ ...envelope, toolCallId });
        break;
    }
  }

  for (const known of knownStations) {
    const station = stations.get(known.station_name);
    if (station) {
      station.status = known.station_status ?? station.status;
      station.group = known.group_name ?? station.group;
    }
  }
  return [...stations.values()];
}

export type StepState = 'running' | 'complete' | 'failed' | 'cancelled';

export interface InvestigationStep {
  toolCallId: string;
  state: StepState;
  label: string;
  detail?: string;
  errorMessage?: string;
  /** 工具正常结束但没有可展示内容时的说明。 */
  notice?: string;
  /** 能归到测点的步骤打开时间轴，其余结果在步骤内展开。 */
  stationName?: string;
  inlineEnvelope?: ToolArtifactEnvelope;
}

const shortDate = (value: string) => value.slice(5, 10);

export const formatDateRange = (begin: string, end: string) =>
  `${shortDate(begin)} 至 ${shortDate(end)}`;

const stepDetail = (envelope: ToolArtifactEnvelope): string | undefined => {
  switch (envelope.kind) {
    case 'gnss_series':
    case 'vision':
      return `${envelope.data.station_name} · ${formatDateRange(envelope.data.begin_time, envelope.data.end_time)}`;
    case 'weather':
      return envelope.data.location.station_name ?? undefined;
    case 'site_environment':
      return envelope.data.center_station.station_name;
    case 'station_list':
      return envelope.data.groups ? `${envelope.data.total} 个分组` : `${envelope.data.total} 个测点`;
    case 'investigation_report':
      return undefined;
  }
};

const failureMessage = (
  status: ToolCallMessagePartStatus,
  envelope: ToolArtifactEnvelope | undefined,
  result: unknown,
): string | undefined => {
  if (envelope?.error?.message) return envelope.error.message;
  if (typeof result === 'string') return result;
  if (status.type !== 'incomplete') return undefined;
  if (typeof status.error === 'string') return status.error;
  return status.error instanceof Error ? status.error.message : undefined;
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

/** 步骤状态只来自官方 tool part，不由前端推测进度。 */
export function buildSteps(
  parts: readonly PartState[],
  stations: readonly StationEvidence[],
): InvestigationStep[] {
  const stationNames = new Set(stations.map((station) => station.name));
  const steps: InvestigationStep[] = [];

  for (const part of parts) {
    if (part.type !== 'tool-call') continue;
    const presentation = presentationOf(part.toolName);
    const envelope = decodeToolPart(part);
    const state = stepStateOf(part, envelope);

    // 简报是回答本身；校验失败由模型修正，用户只需看到正在整理。
    if (part.toolName === REPORT_TOOL_NAME && state !== 'running') continue;

    // 仅供模型使用的工具答复（如基准站说明）不进入用户可见的调查过程。
    if (state === 'complete' && part.artifact === null) continue;

    const name = envelope ? stationNameOf(envelope) : null;
    const stationName = name && stationNames.has(name) ? name : undefined;
    const isEmpty = state === 'complete' && (!envelope || !hasChartableData(envelope));
    const label = {
      running: presentation.running,
      complete: presentation.complete,
      failed: presentation.failed,
      cancelled: presentation.cancelled,
    }[state];

    steps.push({
      toolCallId: part.toolCallId,
      state,
      label,
      detail: envelope ? stepDetail(envelope) : undefined,
      errorMessage: state === 'failed'
        ? failureMessage(part.status as ToolCallMessagePartStatus, envelope, part.result)
        : undefined,
      notice: isEmpty ? presentation.emptyNotice || undefined : undefined,
      stationName,
      inlineEnvelope: envelope && !stationName && !isEmpty ? envelope : undefined,
    });
  }
  return steps;
}

/** 校验失败的提交不产生 artifact，只有通过校验的简报才会被取到。 */
export function findReport(parts: readonly { type: string }[]): InvestigationReportArtifactData | undefined {
  for (const part of [...parts].reverse()) {
    if (!isToolCall(part) || part.toolName !== REPORT_TOOL_NAME) continue;
    const envelope = decodeToolArtifact('investigation_report', part.artifact);
    if (envelope?.kind === 'investigation_report' && envelope.status !== 'error') {
      return envelope.data;
    }
  }
  return undefined;
}

export const STATUS_PRIORITY: Record<InvestigationStatus, number> = {
  需人工复核: 0,
  持续关注: 1,
  数据不足: 2,
  暂无法分析: 3,
  未见明显变化: 4,
};

const FINDING_HEADINGS: Record<FindingLevel, string> = {
  fact: '观测事实',
  analysis: '分析判断',
  inference: '专业推断',
};

export const FINDING_LEVELS: readonly FindingLevel[] = ['fact', 'analysis', 'inference'];

export const findingHeading = (level: FindingLevel) => FINDING_HEADINGS[level];

/** 简报存放在工具结果里，消息没有正文可复制，这里生成可分享的文本。 */
export function reportToMarkdown(report: InvestigationReportArtifactData): string {
  const sections = [
    report.conclusion,
    report.stations
      .map((station) => `- ${station.station_name}：${station.status}。${station.reason}（${station.acceleration}；${station.data_quality}）`)
      .join('\n'),
    ...FINDING_LEVELS.flatMap((level) => {
      const findings = report.findings.filter((finding) => finding.level === level);
      return findings.length > 0
        ? [`## ${FINDING_HEADINGS[level]}\n\n${findings.map((finding) => `- ${finding.text}`).join('\n')}`]
        : [];
    }),
    ...(report.next_steps.length > 0
      ? [`## 建议\n\n${report.next_steps.map((step) => `- ${step}`).join('\n')}`]
      : []),
  ];
  return sections.join('\n\n');
}
