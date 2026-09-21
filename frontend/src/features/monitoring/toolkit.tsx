import type { ReactNode } from 'react';
import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type Toolkit,
} from '@assistant-ui/react';
import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  type ToolDisplayLabels,
} from '@/components/assistant-ui/elements/tool-fallback.aui';
import type {
  ToolArtifactEnvelope,
  ToolArtifactKind,
} from '@/types/envelope';
import { GnssResultView } from './tools/GnssResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { StationResultView } from './tools/StationResultView';
import { VisionResultView } from './tools/VisionResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_ARTIFACT_KINDS = new Set<ToolArtifactKind>([
  'generic',
  'station_list',
  'gnss_series',
  'weather',
  'vision',
  'site_environment',
]);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isEvidenceSource = (value: unknown) => {
  if (!isRecord(value)) return false;
  return [
    'provider',
    'name',
    'role',
    'coordinate_system',
    'observed_at',
    'url',
    'license',
  ].every((key) => value[key] == null || typeof value[key] === 'string');
};

const isStation = (value: unknown) =>
  isRecord(value) &&
  typeof value.station_name === 'string' &&
  value.coordinate_system === 'WGS84';

const isVisionData = (value: unknown) => {
  if (
    !isRecord(value) ||
    typeof value.station_name !== 'string' ||
    typeof value.begin_time !== 'string' ||
    typeof value.end_time !== 'string' ||
    typeof value.timezone !== 'string' ||
    typeof value.total_points !== 'number' ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.chart_points)
  ) {
    return false;
  }
  if (
    !value.images.every(
      (image) =>
        isRecord(image) &&
        typeof image.name === 'string' &&
        typeof image.png_base64 === 'string',
    ) ||
    !value.chart_points.every(
      (point) => isRecord(point) && typeof point.t === 'string',
    )
  ) {
    return false;
  }
  if (value.observations == null) return true;
  if (!isRecord(value.observations)) return false;
  const { candidates, trends, turning_points } = value.observations;
  return (
    (candidates === undefined ||
      (Array.isArray(candidates) &&
        candidates.every(
          (candidate) =>
            isRecord(candidate) &&
            typeof candidate.metric === 'string' &&
            typeof candidate.start_at === 'string' &&
            typeof candidate.end_at === 'string',
        ))) &&
    (trends === undefined || isStringArray(trends)) &&
    (turning_points === undefined || isStringArray(turning_points))
  );
};

const isArtifactData = (kind: ToolArtifactKind, value: unknown) => {
  if (!isRecord(value)) return false;
  switch (kind) {
    case 'generic':
      return (
        typeof value.current_time === 'string' && typeof value.timezone === 'string'
      );
    case 'station_list': {
      const groupsValid =
        value.groups === undefined ||
        value.groups === null ||
        (Array.isArray(value.groups) &&
          value.groups.every(
            (group) =>
              isRecord(group) &&
              typeof group.group_name === 'string' &&
              typeof group.station_count === 'number',
          ));
      const stationsValid =
        value.stations === undefined ||
        value.stations === null ||
        (Array.isArray(value.stations) && value.stations.every(isStation));
      return (
        typeof value.total === 'number' &&
        groupsValid &&
        stationsValid &&
        (Array.isArray(value.groups) !== Array.isArray(value.stations))
      );
    }
    case 'gnss_series':
      return (
        typeof value.station_name === 'string' &&
        typeof value.begin_time === 'string' &&
        typeof value.end_time === 'string' &&
        typeof value.timezone === 'string' &&
        typeof value.total_points === 'number' &&
        typeof value.returned_points === 'number' &&
        typeof value.downsampled === 'boolean' &&
        Array.isArray(value.points) &&
        value.points.every(
          (point) => isRecord(point) && typeof point.time === 'string',
        ) &&
        isRecord(value.summary)
      );
    case 'weather':
      return (
        typeof value.ok === 'boolean' &&
        isRecord(value.location) &&
        typeof value.location.latitude === 'number' &&
        typeof value.location.longitude === 'number' &&
        isRecord(value.query)
      );
    case 'vision':
      return isVisionData(value);
    case 'site_environment':
      return (
        value.version === 1 &&
        typeof value.observed_at === 'string' &&
        value.coordinate_system === 'WGS84' &&
        isStation(value.center_station) &&
        Array.isArray(value.group_stations) &&
        value.group_stations.every(isStation) &&
        isRecord(value.faults) &&
        isRecord(value.layer_sources)
      );
  }
};

/** 仅接受当前版本且 kind 与 renderer 声明一致的持久化 artifact。 */
export function decodeToolArtifact(
  expectedKind: ToolArtifactKind,
  rawArtifact: unknown,
): ToolArtifactEnvelope | undefined {
  if (!isRecord(rawArtifact) || rawArtifact.version !== 1) return undefined;

  const kind = rawArtifact.kind;
  if (
    typeof kind !== 'string' ||
    !KNOWN_ARTIFACT_KINDS.has(kind as ToolArtifactKind) ||
    kind !== expectedKind
  ) {
    return undefined;
  }

  const status = rawArtifact.status;
  if (status !== 'success' && status !== 'partial' && status !== 'error') {
    return undefined;
  }

  if (!isArtifactData(expectedKind, rawArtifact.data)) return undefined;
  if (rawArtifact.observedAt !== undefined && typeof rawArtifact.observedAt !== 'string') {
    return undefined;
  }
  if (
    rawArtifact.limitations !== undefined &&
    !isStringArray(rawArtifact.limitations)
  ) {
    return undefined;
  }
  if (
    rawArtifact.sources !== undefined &&
    (!Array.isArray(rawArtifact.sources) ||
      !rawArtifact.sources.every(isEvidenceSource))
  ) {
    return undefined;
  }
  if (
    rawArtifact.error !== undefined &&
    (!isRecord(rawArtifact.error) ||
      typeof rawArtifact.error.code !== 'string' ||
      typeof rawArtifact.error.category !== 'string' ||
      typeof rawArtifact.error.message !== 'string' ||
      typeof rawArtifact.error.retryable !== 'boolean')
  ) {
    return undefined;
  }
  if (
    (status === 'error' && rawArtifact.error === undefined) ||
    (status !== 'error' && rawArtifact.error !== undefined)
  ) {
    return undefined;
  }

  return {
    version: 1,
    kind: expectedKind,
    status,
    data: rawArtifact.data,
    ...(typeof rawArtifact.observedAt === 'string'
      ? { observedAt: rawArtifact.observedAt }
      : {}),
    ...(Array.isArray(rawArtifact.sources) ? { sources: rawArtifact.sources } : {}),
    ...(isStringArray(rawArtifact.limitations)
      ? { limitations: rawArtifact.limitations }
      : {}),
    ...(isRecord(rawArtifact.error) ? { error: rawArtifact.error } : {}),
  } as ToolArtifactEnvelope;
}

type MonitoringToolDefinition = {
  kind: ToolArtifactKind;
  labels: ToolDisplayLabels;
  emptyText: string;
  render: (envelope: ToolArtifactEnvelope) => ReactNode;
};

const resolveStatus = (
  status: ToolCallMessagePartStatus,
  isError: boolean | undefined,
  result: unknown,
  envelope: ToolArtifactEnvelope | undefined,
): ToolCallMessagePartStatus => {
  if (
    (isError === true || envelope?.status === 'error') &&
    status.type !== 'requires-action' &&
    !(status.type === 'incomplete' && status.reason === 'cancelled')
  ) {
    return {
      type: 'incomplete',
      reason: 'error',
      error:
        envelope?.error?.message ||
        (typeof result === 'string' ? result : undefined),
    };
  }
  return status;
};

const errorText = (status: ToolCallMessagePartStatus) => {
  if (status.type !== 'incomplete') return undefined;
  if (typeof status.error === 'string') return status.error;
  if (status.error instanceof Error) return status.error.message;
  return undefined;
};

export const MonitoringToolCall = ({
  definition,
  ...props
}: ToolCallMessagePartProps & { definition: MonitoringToolDefinition }) => {
  // 正常完成但没有展示 artifact：仅供模型使用的工具答复，不解释 content。
  if (props.status.type === 'complete' && !props.isError && props.artifact === null) {
    return null;
  }
  const envelope = decodeToolArtifact(definition.kind, props.artifact);
  const status = resolveStatus(
    props.status,
    props.isError,
    props.result,
    envelope,
  );

  return (
    <ToolFallbackRoot>
      <ToolFallbackTrigger
        toolName={props.toolName}
        status={status}
        labels={definition.labels}
      />
      <ToolFallbackContent>
        {status.type === 'incomplete' ? (
          <>
            <div className="py-1 text-xs font-medium text-destructive/90">
              {status.reason === 'cancelled'
                ? '操作已取消'
                : errorText(status) || definition.labels.error}
            </div>
            {status.reason !== 'cancelled' &&
              envelope?.data !== undefined && (
                <div className="mt-1">{definition.render(envelope)}</div>
              )}
          </>
        ) : status.type === 'complete' ? (
          envelope && envelope.status !== 'error' && envelope.data !== undefined ? (
            <div className="mt-1">{definition.render(envelope)}</div>
          ) : (
            <div className="py-1 text-xs font-normal text-muted-foreground/80">
              {definition.emptyText}
            </div>
          )
        ) : null}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const stationLabels: ToolDisplayLabels = {
  running: '正在查询监测点信息…',
  complete: '已查询监测点信息',
  error: '监测点信息查询失败',
  cancelled: '已取消查询监测点信息',
  requiresAction: '待确认监测点查询',
};

const definitions = {
  list_station_groups: {
    kind: 'station_list',
    labels: {
      running: '正在查询监测点分组…',
      complete: '已查询监测点分组',
      error: '监测点分组查询失败',
      cancelled: '已取消查询监测点分组',
      requiresAction: '待确认监测点分组查询',
    },
    emptyText: '未查询到符合条件的监测点分组。',
    render: (envelope) =>
      envelope.kind === 'station_list' ? (
        <StationResultView data={envelope.data} />
      ) : null,
  },
  list_stations: {
    kind: 'station_list',
    labels: stationLabels,
    emptyText: '未查询到符合条件的监测点。',
    render: (envelope) =>
      envelope.kind === 'station_list' ? (
        <StationResultView data={envelope.data} />
      ) : null,
  },
  get_daily_gnss_data: {
    kind: 'gnss_series',
    labels: {
      running: '正在获取 GNSS 监测数据…',
      complete: '已获取 GNSS 监测数据',
      error: 'GNSS 数据获取失败',
      cancelled: '已取消获取 GNSS 监测数据',
      requiresAction: '待确认 GNSS 数据查询',
    },
    emptyText: '未查询到符合条件的业务监测数据。',
    render: (envelope) =>
      envelope.kind === 'gnss_series' ? (
        <GnssResultView data={envelope.data} />
      ) : null,
  },
  query_weather: {
    kind: 'weather',
    labels: {
      running: '正在查询同期天气…',
      complete: '已获取同期天气',
      error: '天气数据查询失败',
      cancelled: '已取消查询天气',
      requiresAction: '待确认天气查询',
    },
    emptyText: '未查询到符合条件的天气数据。',
    render: (envelope) =>
      envelope.kind === 'weather' ? (
        <WeatherResultView data={envelope.data} />
      ) : null,
  },
  analyze_gnss_chart: {
    kind: 'vision',
    labels: {
      running: '正在复核位移曲线…',
      complete: '已完成位移曲线复核',
      error: '位移曲线复核失败',
      cancelled: '已取消复核位移曲线',
      requiresAction: '待确认位移曲线复核',
    },
    emptyText: '未取得可展示的位移曲线复核结果。',
    render: (envelope) =>
      envelope.kind === 'vision' ? (
        <VisionResultView data={envelope.data} />
      ) : null,
  },
  inspect_site_environment: {
    kind: 'site_environment',
    labels: {
      running: '正在获取场地环境信息…',
      complete: '已获取场地环境信息',
      error: '场地环境信息获取失败',
      cancelled: '已取消调查场地环境',
      requiresAction: '待确认场地环境调查',
    },
    emptyText: '未取得可展示的场地环境信息。',
    render: (envelope) =>
      envelope.kind === 'site_environment' ? (
        <SiteEnvironmentResultView
          environment={envelope.data}
          limitations={envelope.limitations}
        />
      ) : null,
  },
} satisfies Record<string, MonitoringToolDefinition>;

const createRenderer = (
  definition: MonitoringToolDefinition,
): ToolCallMessagePartComponent =>
  function MonitoringToolRenderer(props) {
    return <MonitoringToolCall {...props} definition={definition} />;
  };

export const monitoringToolRenderers = {
  list_station_groups: createRenderer(definitions.list_station_groups),
  list_stations: createRenderer(definitions.list_stations),
  get_daily_gnss_data: createRenderer(definitions.get_daily_gnss_data),
  query_weather: createRenderer(definitions.query_weather),
  analyze_gnss_chart: createRenderer(definitions.analyze_gnss_chart),
  inspect_site_environment: createRenderer(definitions.inspect_site_environment),
};

export const monitoringToolkit = {
  list_station_groups: {
    type: 'backend',
    render: monitoringToolRenderers.list_station_groups,
  },
  list_stations: {
    type: 'backend',
    render: monitoringToolRenderers.list_stations,
  },
  get_daily_gnss_data: {
    type: 'backend',
    render: monitoringToolRenderers.get_daily_gnss_data,
  },
  query_weather: {
    type: 'backend',
    render: monitoringToolRenderers.query_weather,
  },
  analyze_gnss_chart: {
    type: 'backend',
    render: monitoringToolRenderers.analyze_gnss_chart,
  },
  inspect_site_environment: {
    type: 'backend',
    render: monitoringToolRenderers.inspect_site_environment,
  },
} satisfies Toolkit;
