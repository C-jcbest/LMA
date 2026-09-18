import type { ToolArtifactEnvelope, ToolArtifactKind } from '../types/envelope';

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

export const TOOL_KIND_MAP: Record<string, { label: string; kind: ToolArtifactKind; defaultExpanded?: boolean }> = {
  list_station_groups: {
    label: '查询监测点分组',
    kind: 'station_list',
  },
  list_stations: {
    label: '查询监测点列表',
    kind: 'station_list',
  },
  get_daily_gnss_data: {
    label: '获取北斗GNSS日监测数据',
    kind: 'gnss_series',
  },
  query_weather: {
    label: '查询天气数据',
    kind: 'weather',
  },
  analyze_gnss_chart: {
    label: '视觉复核',
    kind: 'vision',
  },
  visual_review: {
    label: '视觉复核',
    kind: 'vision',
  },
  inspect_site_environment: {
    label: '调查站点地形与地质环境',
    kind: 'site_environment',
    defaultExpanded: true,
  },
  site_environment: {
    label: '调查站点地形与地质环境',
    kind: 'site_environment',
    defaultExpanded: true,
  },
  get_current_time: {
    label: '获取当前时间',
    kind: 'generic',
  },
};

/**
 * 集中解码函数：将 live output 或 artifact 统一归整为版本化的 ToolArtifactEnvelope (Version 1)
 */
export function decodeToolEnvelope(
  toolName: string,
  rawArtifact: unknown,
  rawOutput: unknown
): ToolArtifactEnvelope {
  const meta = TOOL_KIND_MAP[toolName] || {
    label: '执行工具查询',
    kind: 'generic' as ToolArtifactKind,
  };

  const artifactRecord = isRecord(rawArtifact) ? rawArtifact : undefined;
  const outputRecord = parseOutputRecord(rawOutput);

  // 1. 若 artifact 本身已是 version 1 信封
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

  // 2. 若 liveOutput 已符合 version 1 规范
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

  // 3. 消费传统结构（ToolMessage.artifact 优先，live output 次之）
  const source = artifactRecord || outputRecord || {};
  const data = source.data !== undefined ? source.data : source;

  return {
    version: 1,
    kind: meta.kind,
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
