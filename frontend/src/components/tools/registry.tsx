import React from 'react';
import type { ToolArtifactEnvelope, ToolArtifactKind } from '../../types/envelope';
import type { ToolCallImage, SiteEnvironmentArtifact } from '../toolArtifacts';
import { StationResultView } from './StationResultView';
import { GnssResultView } from './GnssResultView';
import { WeatherResultView } from './WeatherResultView';
import { VisionResultView } from './VisionResultView';
import { SiteEnvironmentResultView } from './SiteEnvironmentResultView';
import { EmptyOrGenericResultView } from './EmptyOrGenericResultView';

export interface ToolRendererProps<T = any> {
  envelope: ToolArtifactEnvelope<T>;
  data: any;
  artifactImages?: ToolCallImage[];
  siteEnvironment?: SiteEnvironmentArtifact;
}

export interface ToolRegistryItem {
  label: string;
  artifactKind: ToolArtifactKind;
  render: React.ComponentType<ToolRendererProps>;
  defaultExpanded?: boolean;
}

const StationRenderer: React.FC<ToolRendererProps> = ({ data }) => {
  if (!data || (!Array.isArray(data.groups) && !Array.isArray(data.stations))) {
    return <EmptyOrGenericResultView />;
  }
  return <StationResultView data={data} />;
};

const GnssRenderer: React.FC<ToolRendererProps> = ({ data }) => {
  if (!data || !Array.isArray(data.points)) {
    return <EmptyOrGenericResultView />;
  }
  return <GnssResultView data={data} />;
};

const WeatherRenderer: React.FC<ToolRendererProps> = ({ data }) => {
  if (!data || (!data.current && !data.rain_summary)) {
    return <EmptyOrGenericResultView />;
  }
  return <WeatherResultView data={data} />;
};

const VisionRenderer: React.FC<ToolRendererProps> = ({ data, artifactImages }) => {
  if (!data || !Array.isArray(data.chart_points)) {
    return <EmptyOrGenericResultView />;
  }
  return <VisionResultView data={data} artifactImages={artifactImages} />;
};

const SiteEnvironmentRenderer: React.FC<ToolRendererProps> = ({ siteEnvironment, data }) => {
  const env = siteEnvironment || data?.site_environment;
  if (!env) return <EmptyOrGenericResultView />;
  return <SiteEnvironmentResultView environment={env} />;
};

export const toolRegistry: Record<string, ToolRegistryItem> = {
  list_station_groups: {
    label: '查询监测点分组',
    artifactKind: 'station_list',
    render: StationRenderer,
  },
  list_stations: {
    label: '查询监测点列表',
    artifactKind: 'station_list',
    render: StationRenderer,
  },
  get_daily_gnss_data: {
    label: '获取北斗GNSS日监测数据',
    artifactKind: 'gnss_series',
    render: GnssRenderer,
  },
  query_weather: {
    label: '查询天气数据',
    artifactKind: 'weather',
    render: WeatherRenderer,
  },
  analyze_gnss_chart: {
    label: '视觉复核',
    artifactKind: 'vision',
    render: VisionRenderer,
  },
  inspect_site_environment: {
    label: '调查站点地形与地质环境',
    artifactKind: 'site_environment',
    render: SiteEnvironmentRenderer,
    defaultExpanded: true,
  },
};

export function getToolRegistryItem(toolName: string): ToolRegistryItem {
  return (
    toolRegistry[toolName] || {
      label: '执行工具查询',
      artifactKind: 'generic',
      render: EmptyOrGenericResultView,
      defaultExpanded: false,
    }
  );
}

export const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseOutputRecord = (output: unknown): Record<string, any> | undefined => {
  if (isRecord(output)) return output;
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * 统一解码函数：将 liveToolCall.output 或 ToolMessage.artifact 统一解码为版本化的 ToolArtifactEnvelope
 */
export function decodeToolArtifact(
  toolName: string,
  rawArtifact: unknown,
  rawOutput: unknown
): ToolArtifactEnvelope {
  const item = getToolRegistryItem(toolName);
  const artifactRecord = isRecord(rawArtifact) ? rawArtifact : undefined;
  const outputRecord = parseOutputRecord(rawOutput);

  // 1. 若 artifact 本身已符合 version 1 envelope 规范
  if (artifactRecord && artifactRecord.version === 1 && typeof artifactRecord.kind === 'string') {
    return {
      version: 1,
      kind: artifactRecord.kind as ToolArtifactKind,
      status: (artifactRecord.status as any) || (artifactRecord.error ? 'error' : 'success'),
      data: artifactRecord.data !== undefined ? artifactRecord.data : artifactRecord,
      observedAt: artifactRecord.observedAt,
      sources: artifactRecord.sources,
      limitations: artifactRecord.limitations,
      error: artifactRecord.error,
      site_environment: artifactRecord.site_environment,
      chart_points: artifactRecord.chart_points,
      images: artifactRecord.images,
    };
  }

  // 2. 若 liveOutput 已符合 version 1 envelope 规范
  if (outputRecord && outputRecord.version === 1 && typeof outputRecord.kind === 'string') {
    return {
      version: 1,
      kind: outputRecord.kind as ToolArtifactKind,
      status: (outputRecord.status as any) || (outputRecord.error ? 'error' : 'success'),
      data: outputRecord.data !== undefined ? outputRecord.data : outputRecord,
      observedAt: outputRecord.observedAt,
      sources: outputRecord.sources,
      limitations: outputRecord.limitations,
      error: outputRecord.error,
      site_environment: outputRecord.site_environment,
      chart_points: outputRecord.chart_points,
      images: outputRecord.images,
    };
  }

  // 3. 规整传统结构（ToolMessage.artifact 优先，liveToolCall.output 次之）
  const source = artifactRecord || outputRecord || {};
  const data = source.data !== undefined ? source.data : source;

  return {
    version: 1,
    kind: item.artifactKind,
    status: source.error ? 'error' : 'success',
    data,
    observedAt: source.observedAt,
    sources: source.sources,
    limitations: source.limitations,
    error: source.error,
    site_environment: source.site_environment,
    chart_points: source.chart_points,
    images: source.images,
  };
}
