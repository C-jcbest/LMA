import type { ToolArtifactEnvelope, ToolArtifactKind } from '@/types/envelope';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 服务端投影的内部参数纠错；保留官方 error 配对，不当作业务取数结果。 */
export const isToolFeedback = (value: unknown): boolean =>
  isRecord(value) && value.version === 1 && value.kind === 'tool_feedback' && value.category === 'input_validation';

const KNOWN_ARTIFACT_KINDS = new Set<ToolArtifactKind>([
  'acquisition_failure',
  'conclusions',
  'computation',
  'station_list',
  'gnss_series',
  'station_overview',
  'weather',
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

const isGnssData = (value: unknown) => (
  isRecord(value) &&
  typeof value.station_name === 'string' &&
  typeof value.begin_time === 'string' &&
  typeof value.end_time === 'string' &&
  typeof value.timezone === 'string' &&
  typeof value.total_points === 'number' &&
  typeof value.returned_points === 'number' &&
  typeof value.downsampled === 'boolean' &&
  Array.isArray(value.points) &&
  value.points.every((point) => isRecord(point) && typeof point.time === 'string') &&
  isRecord(value.summary) &&
  Array.isArray(value.summary.gaps)
);

const isArtifactData = (kind: ToolArtifactKind, value: unknown) => {
  if (!isRecord(value)) return false;
  switch (kind) {
    case 'acquisition_failure':
      return typeof value.station_name === 'string' && typeof value.message === 'string'
        && typeof value.requested_station === 'string';
    case 'conclusions':
      return (
        Array.isArray(value.stations) &&
        value.stations.every((station) => isRecord(station)
          && typeof station.station_uuid === 'string' && typeof station.station_name === 'string'
          && typeof station.status === 'string' && typeof station.reason === 'string'
          && typeof station.begin_time === 'string' && typeof station.end_time === 'string'
          && isStringArray(station.evidence))
      );
    case 'computation':
      return (
        typeof value.description === 'string' && typeof value.code === 'string'
        && typeof value.truncated === 'boolean' && 'result' in value
        && Array.isArray(value.inputs)
        && value.inputs.every((input) => isRecord(input) && typeof input.evidence_id === 'string'
          && typeof input.description === 'string')
      );
    case 'station_list':
      return (
        typeof value.total === 'number' &&
        Array.isArray(value.groups) &&
        value.groups.every((group) => isRecord(group) && typeof group.group_name === 'string'
          && typeof group.station_count === 'number') &&
        Array.isArray(value.stations) &&
        value.stations.every(isStation)
      );
    case 'gnss_series':
      return isGnssData(value);
    case 'station_overview':
      return (
        typeof value.station_uuid === 'string' &&
        typeof value.station_name === 'string' &&
        Array.isArray(value.windows) &&
        value.windows.length > 0 &&
        value.windows.every(isGnssData)
      );
    case 'weather':
      return (
        typeof value.ok === 'boolean' &&
        isRecord(value.location) &&
        typeof value.location.latitude === 'number' &&
        typeof value.location.longitude === 'number' &&
        isRecord(value.query)
      );
    case 'site_environment':
      return (
        value.version === 1 &&
        typeof value.observed_at === 'string' &&
        value.coordinate_system === 'WGS84' &&
        isStation(value.center_station) &&
        Array.isArray(value.group_stations) &&
        value.group_stations.every(isStation)
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
    ...(typeof rawArtifact.evidence_id === 'string' ? { evidence_id: rawArtifact.evidence_id } : {}),
    ...(typeof rawArtifact.observedAt === 'string'
      ? { observedAt: rawArtifact.observedAt }
      : {}),
    ...(typeof rawArtifact.summary === 'string' ? { summary: rawArtifact.summary } : {}),
    ...(Array.isArray(rawArtifact.sources) ? { sources: rawArtifact.sources } : {}),
    ...(isStringArray(rawArtifact.limitations)
      ? { limitations: rawArtifact.limitations }
      : {}),
    ...(isRecord(rawArtifact.error) ? { error: rawArtifact.error } : {}),
  } as ToolArtifactEnvelope;
}
