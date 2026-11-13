import { describe, expect, it } from 'vitest';
import { mapContentOf } from '../src/features/monitoring/EvidenceCards';
import type { StationEvidence } from '../src/features/monitoring/investigation';
import { azimuthDifference, azimuthOf } from '../src/features/monitoring/map-markers';
import { horizontalTrack } from '../src/features/monitoring/timeline';
import type { GnssArtifactData, SiteEnvironmentArtifactData } from '../src/types/envelope';

const series = (fields: Partial<GnssArtifactData> = {}): GnssArtifactData => ({
  station_uuid: 'uuid-A',
  station_name: '测点A',
  begin_time: '2026-11-01 00:00:00',
  end_time: '2026-11-03 00:00:00',
  timezone: 'Asia/Shanghai',
  total_points: 3,
  returned_points: 3,
  downsampled: false,
  points: [
    { time: '2026-11-01 00:00:00', n: 100.001, e: 200.001, u: 300 },
    { time: '2026-11-02 00:00:00', n: null, e: 200.002, u: 300 },
    { time: '2026-11-03 00:00:00', n: 100.003, e: 200.004, u: 300 },
  ],
  summary: { n: { count: 2 }, e: { count: 3 }, u: { count: 3 }, gaps: [] },
  reference: { coordinates_m: { n: 100, e: 200, u: 300 } },
  location: {
    group_name: 'K3', latitude: 30.1, longitude: 103.2,
    group_stations: [
      { station_uuid: 'uuid-B', station_name: '测点B', station_type: '移动站RTK模式', latitude: 30.11, longitude: 103.21 },
      { station_uuid: 'uuid-C', station_name: '坐标错误点', latitude: 116.4, longitude: 39.9 },
    ],
  },
  ...fields,
});

const site = (aspect: number): SiteEnvironmentArtifactData => ({
  version: 1,
  observed_at: '2026-11-03T00:00:00+08:00',
  coordinate_system: 'WGS84',
  center_station: { station_uuid: 'uuid-A', station_name: '测点A', latitude: 30.1, longitude: 103.2, coordinate_system: 'WGS84' },
  group_stations: [],
  terrain: { aspect_degrees: aspect, slope_degrees: 30 },
  faults: { available: true, distance_km: null, note: '' },
  layer_sources: {},
} as unknown as SiteEnvironmentArtifactData);

const station = (fields: Partial<StationEvidence> = {}): StationEvidence => ({
  id: 'uuid-A',
  uuid: 'uuid-A',
  name: '测点A',
  coordinates: { latitude: 30.1, longitude: 103.2 },
  series: [{ version: 1, kind: 'gnss_series', status: 'success', data: series(), toolCallId: 'g1' }],
  weather: [],
  site: [],
  ...fields,
});

describe('对话中的测点地图', () => {
  it('单个测点也画地图，同组其他测点作灰色参照，坐标非法的参照点不画', () => {
    const content = mapContentOf([station()], new Map());
    expect(content.stations.map((item) => item.name)).toEqual(['测点A']);
    expect(content.references.map((item) => item.name)).toEqual(['测点B']);
  });

  it('有场地依据时带出下坡方向，轨迹是相对固定参考的水平位移并跳过分量缺失的时刻', () => {
    const content = mapContentOf([station({
      site: [{ version: 1, kind: 'site_environment', status: 'success', data: site(95), toolCallId: 's1' }],
    })], new Map());
    const [mapStation] = content.stations;
    expect(mapStation!.downslopeAzimuth).toBe(95);
    expect(mapStation!.track).toEqual([
      { time: '2026-11-01 00:00:00', north: 1, east: 1 },
      { time: '2026-11-03 00:00:00', north: 3, east: 4 },
    ]);
    expect(mapStation!.northMillimeters).toBe(3);
    expect(mapStation!.eastMillimeters).toBe(4);
  });

  it('轨迹点过多时等间隔抽取并保留首末点', () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({
      time: `t${String(index).padStart(4, '0')}`, n: 100 + index / 1000, e: 200, u: 300,
    }));
    const track = horizontalTrack(series({ points }), 240);
    expect(track).toHaveLength(240);
    expect(track[0]!.time).toBe('t0000');
    expect(track.at(-1)!.time).toBe('t0999');
  });

  it('方位从正北顺时针，夹角取较小的一侧', () => {
    expect(azimuthOf(0, 1)).toBe(90);
    expect(azimuthOf(-1, 0)).toBe(180);
    expect(azimuthDifference(350, 10)).toBe(20);
    expect(azimuthDifference(90, 270)).toBe(180);
  });
});
