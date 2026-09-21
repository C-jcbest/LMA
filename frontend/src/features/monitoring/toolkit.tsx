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
import type { ToolArtifactEnvelope, ToolArtifactKind } from '@/types/envelope';
import { GnssResultView } from './tools/GnssResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { StationResultView } from './tools/StationResultView';
import { VisionResultView } from './tools/VisionResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_ARTIFACT_KINDS = new Set<ToolArtifactKind>([
  'station_list',
  'gnss_series',
  'weather',
  'vision',
  'station_comparison',
  'site_environment',
  'monitoring_map',
  'evidence',
  'generic',
]);

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

  if (status === 'success') {
    const data = rawArtifact.data;
    if (kind === 'gnss_series') {
      if (!isRecord(data) || !Array.isArray(data.points)) return undefined;
    } else if (kind === 'station_list') {
      if (
        !isRecord(data) ||
        (!Array.isArray(data.stations) && !Array.isArray(data.groups))
      ) {
        return undefined;
      }
    } else if (kind === 'weather') {
      if (!isRecord(data)) return undefined;
    } else if (kind === 'vision') {
      const hasPoints =
        Array.isArray(rawArtifact.chart_points) ||
        (isRecord(data) && Array.isArray(data.chart_points));
      const hasImages =
        Array.isArray(rawArtifact.images) ||
        (isRecord(data) && Array.isArray(data.images));
      if (!hasPoints && !hasImages && !isRecord(data)) return undefined;
    } else if (kind === 'site_environment') {
      const hasEnvironment =
        isRecord(rawArtifact.site_environment) ||
        (isRecord(data) && isRecord(data.site_environment)) ||
        isRecord(data);
      if (!hasEnvironment) return undefined;
    }
  }

  return {
    version: 1,
    kind: kind as ToolArtifactKind,
    status,
    data: rawArtifact.data,
    observedAt: rawArtifact.observedAt,
    sources: rawArtifact.sources,
    limitations: rawArtifact.limitations,
    error: rawArtifact.error,
    site_environment: rawArtifact.site_environment,
    chart_points: rawArtifact.chart_points,
    images: rawArtifact.images,
  };
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
    render: (envelope) => <StationResultView data={envelope.data} />,
  },
  list_stations: {
    kind: 'station_list',
    labels: stationLabels,
    emptyText: '未查询到符合条件的监测点。',
    render: (envelope) => <StationResultView data={envelope.data} />,
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
    render: (envelope) => <GnssResultView data={envelope.data} />,
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
    render: (envelope) => <WeatherResultView data={envelope.data} />,
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
    render: (envelope) => {
      const data = isRecord(envelope.data) ? envelope.data : {};
      const mergedData = {
        ...data,
        chart_points: data.chart_points || envelope.chart_points || [],
      };
      const images = envelope.images || data.images || [];
      return <VisionResultView data={mergedData} artifactImages={images} />;
    },
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
    render: (envelope) => {
      const data = isRecord(envelope.data) ? envelope.data : undefined;
      const environment =
        envelope.site_environment || data?.site_environment || data;
      return environment ? (
        <SiteEnvironmentResultView environment={environment} />
      ) : null;
    },
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
