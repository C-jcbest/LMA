import type { ToolArtifactEnvelope, ToolArtifactKind } from '@/types/envelope';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_ARTIFACT_KINDS = new Set<ToolArtifactKind>([
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
        isRecord(value.summary) &&
        Array.isArray(value.summary.gaps)
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
