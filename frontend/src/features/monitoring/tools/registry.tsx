import React from 'react';
import type { ToolArtifactEnvelope, ToolArtifactKind } from '@/types/envelope';
import type { ToolCallImage, SiteEnvironmentArtifact } from '@/components/toolArtifacts';
import { StationResultView } from './StationResultView';
import { GnssResultView } from './GnssResultView';
import { WeatherResultView } from './WeatherResultView';
import { VisionResultView } from './VisionResultView';
import { SiteEnvironmentResultView } from './SiteEnvironmentResultView';

export interface ToolRendererProps<T = any> {
  envelope: ToolArtifactEnvelope<T>;
  data: any;
  artifactImages?: ToolCallImage[];
  siteEnvironment?: SiteEnvironmentArtifact;
}

export interface ToolRegistryItem {
  label: string;
  runningLabel: string;
  completeLabel: string;
  errorLabel?: string;
  cancelledLabel?: string;
  artifactKind: ToolArtifactKind;
  render: React.ComponentType<ToolRendererProps>;
  defaultExpanded?: boolean;
}

export const FALLBACK_TOOL_LABELS = {
  running: '正在获取辅助信息…',
  complete: '已完成辅助查询',
  error: '辅助查询失败',
  cancelled: '已取消辅助查询',
  requiresAction: '待确认辅助操作',
} as const;

export const toolRegistry: Record<string, ToolRegistryItem> = {
  list_station_groups: {
    label: '查询监测点分组',
    runningLabel: '正在查询监测点分组…',
    completeLabel: '已查询监测点分组',
    errorLabel: '监测点分组查询失败',
    cancelledLabel: '已取消查询监测点分组',
    artifactKind: 'station_list',
    render: ({ data }) => (data ? <StationResultView data={data} /> : null),
  },
  list_stations: {
    label: '查询监测点信息',
    runningLabel: '正在查询监测点信息…',
    completeLabel: '已查询监测点信息',
    errorLabel: '监测点信息查询失败',
    cancelledLabel: '已取消查询监测点信息',
    artifactKind: 'station_list',
    render: ({ data }) => (data ? <StationResultView data={data} /> : null),
  },
  get_daily_gnss_data: {
    label: '获取 GNSS 监测数据',
    runningLabel: '正在获取 GNSS 监测数据…',
    completeLabel: '已获取 GNSS 监测数据',
    errorLabel: 'GNSS 数据获取失败',
    cancelledLabel: '已取消获取 GNSS 监测数据',
    artifactKind: 'gnss_series',
    render: ({ data }) => (data ? <GnssResultView data={data} /> : null),
  },
  query_weather: {
    label: '查询同期天气',
    runningLabel: '正在查询同期天气…',
    completeLabel: '已获取同期天气',
    errorLabel: '天气数据查询失败',
    cancelledLabel: '已取消查询天气',
    artifactKind: 'weather',
    render: ({ data }) => (data ? <WeatherResultView data={data} /> : null),
  },
  analyze_gnss_chart: {
    label: '复核位移曲线',
    runningLabel: '正在复核位移曲线…',
    completeLabel: '已完成位移曲线复核',
    errorLabel: '位移曲线复核失败',
    cancelledLabel: '已取消复核位移曲线',
    artifactKind: 'vision',
    render: ({ data, artifactImages, envelope }) => {
      const mergedData = {
        ...(data || {}),
        chart_points: data?.chart_points || envelope?.chart_points || [],
      };
      const images = artifactImages || envelope?.images || data?.images || [];
      return <VisionResultView data={mergedData} artifactImages={images} />;
    },
  },
  inspect_site_environment: {
    label: '调查场地环境',
    runningLabel: '正在获取场地环境信息…',
    completeLabel: '已获取场地环境信息',
    errorLabel: '场地环境信息获取失败',
    cancelledLabel: '已取消调查场地环境',
    artifactKind: 'site_environment',
    render: ({ siteEnvironment, data }) => {
      const env = siteEnvironment || data?.site_environment;
      return env ? <SiteEnvironmentResultView environment={env} /> : null;
    },
    defaultExpanded: true,
  },
};

export function getToolRegistryItem(toolName: string): ToolRegistryItem | undefined {
  return toolRegistry[toolName];
}

export const isRecord = (value: unknown): value is Record<string, any> =>
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

/**
 * 严格版本化 ToolArtifactEnvelope 解码函数：
 * 仅接受符合 version 1 规范且与注册工具 artifactKind 严格匹配的合法产物。
 * 绝不尝试 JSON.parse 猜测或自动包裹传统未标记结构。
 */
export function decodeToolArtifact(
  toolName: string,
  rawArtifact: unknown,
): ToolArtifactEnvelope | undefined {
  if (!isRecord(rawArtifact)) return undefined;

  // 1. 版本严格限制为 1
  if (rawArtifact.version !== 1) return undefined;

  // 2. kind 必须属于合法 ToolArtifactKind
  const kind = rawArtifact.kind;
  if (typeof kind !== 'string' || !KNOWN_ARTIFACT_KINDS.has(kind as ToolArtifactKind)) {
    return undefined;
  }

  // 3. status 必须合法
  const status = rawArtifact.status;
  if (status !== 'success' && status !== 'partial' && status !== 'error') {
    return undefined;
  }

  // 4. 若为注册的已知工具，kind 必须与 registry 项声明的 artifactKind 严格一致
  const registryItem = getToolRegistryItem(toolName);
  if (registryItem && registryItem.artifactKind !== kind) {
    return undefined;
  }

  // 5. 业务 success 状态下校验各领域最低限度的数据有效性
  if (status === 'success') {
    const data = rawArtifact.data;
    if (kind === 'gnss_series') {
      if (!isRecord(data) || !Array.isArray(data.points)) return undefined;
    } else if (kind === 'station_list') {
      if (!isRecord(data) || (!Array.isArray(data.stations) && !Array.isArray(data.groups))) {
        return undefined;
      }
    } else if (kind === 'weather') {
      if (!isRecord(data)) return undefined;
    } else if (kind === 'vision') {
      const hasPoints = Array.isArray(rawArtifact.chart_points) || (isRecord(data) && Array.isArray(data.chart_points));
      const hasImages = Array.isArray(rawArtifact.images) || (isRecord(data) && Array.isArray(data.images));
      if (!hasPoints && !hasImages && !isRecord(data)) return undefined;
    } else if (kind === 'site_environment') {
      const hasEnv =
        isRecord(rawArtifact.site_environment) ||
        (isRecord(data) && isRecord(data.site_environment)) ||
        isRecord(data);
      if (!hasEnv) return undefined;
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
