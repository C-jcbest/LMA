import { describe, expect, it } from 'vitest';
import { mapContentOf } from '../src/features/monitoring/EvidenceCards';
import type { StationEvidence } from '../src/features/monitoring/investigation';
import { azimuthDifference, azimuthOf, createMapMarker, placeMapMarkerLabels, setDisplacementArrow } from '../src/features/monitoring/map-markers';
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
});

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

  it('标签避开向右位移箭头，且忽略非有限坐标点位而不抛出错误', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 400 });
    Object.defineProperty(container, 'clientHeight', { value: 300 });
    const element = createMapMarker({ name: '测点A', detail: '10 mm', colorToken: '--status-critical' });
    Object.defineProperty(element, 'clientWidth', { value: 44 });
    Object.defineProperty(element, 'clientHeight', { value: 44 });
    setDisplacementArrow(element, { azimuth: 90, lengthPixels: 40 });
    const label = element.querySelector<HTMLElement>('.evidence-map-marker__label')!;
    Object.defineProperty(label, 'offsetWidth', { value: 80 });
    Object.defineProperty(label, 'offsetHeight', { value: 36 });

    const broken = createMapMarker({ name: '坏坐标', detail: '-', colorToken: '--status-normal' });
    const mockMap = {
      lngLatToContainer: (pos: unknown) => (pos === 'ok' ? { x: 200, y: 150 } : { x: Number.NaN, y: Number.NaN }),
    } as unknown as AMap.Map;

    placeMapMarkerLabels(mockMap, container, [
      { marker: { getPosition: () => 'ok' } as unknown as AMap.Marker, element },
      { marker: { getPosition: () => 'bad' } as unknown as AMap.Marker, element: broken },
    ]);

    const leftOffset = Number.parseFloat(label.style.left);
    expect(leftOffset).toBeLessThan(0);
  });

  it('屏幕近距重合测点按优先级自动聚类并标注数量，次要重叠参照点自动折叠标签', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 420 });
    Object.defineProperty(container, 'clientHeight', { value: 320 });

    const makeNode = (name: string) => {
      const el = createMapMarker({ name, detail: '', colorToken: '--status-critical' });
      Object.defineProperty(el, 'clientWidth', { value: 44 });
      Object.defineProperty(el, 'clientHeight', { value: 44 });
      const lbl = el.querySelector<HTMLElement>('.evidence-map-marker__label')!;
      Object.defineProperty(lbl, 'offsetWidth', { value: 110 });
      Object.defineProperty(lbl, 'offsetHeight', { value: 28 });
      return { el, lbl };
    };

    const primary = makeNode('主测点');
    const colocated = makeNode('同址测点');
    const crowdedRef = makeNode('拥挤参照点');

    const coords: Record<string, { x: number; y: number }> = {
      p1: { x: 200, y: 160 },
      p2: { x: 204, y: 162 },
      // Positioned in a tight corner surrounded by markers so all label candidates collide
      p3: { x: 18, y: 56 },
      b1: { x: 80, y: 56 },
      b2: { x: 18, y: 92 },
    };
    const blocker1 = makeNode('占位1');
    const blocker2 = makeNode('占位2');
    const mockMap = {
      lngLatToContainer: (pos: string) => coords[pos]!,
    } as unknown as AMap.Map;

    placeMapMarkerLabels(mockMap, container, [
      { marker: { getPosition: () => 'p2' } as unknown as AMap.Marker, element: colocated.el, id: 'station:2', priority: 10, isPrimary: true },
      { marker: { getPosition: () => 'p1' } as unknown as AMap.Marker, element: primary.el, id: 'station:1', priority: 40, isPrimary: true },
      { marker: { getPosition: () => 'b1' } as unknown as AMap.Marker, element: blocker1.el, id: 'station:b1', priority: 30, isPrimary: true },
      { marker: { getPosition: () => 'b2' } as unknown as AMap.Marker, element: blocker2.el, id: 'station:b2', priority: 30, isPrimary: true },
      { marker: { getPosition: () => 'p3' } as unknown as AMap.Marker, element: crowdedRef.el, id: 'ref:3', priority: 5, isPrimary: false },
    ]);

    expect(primary.el.dataset.clustered).toBe('leader');
    expect(primary.el.dataset.clusterIds).toBe('station:1,station:2');
    expect(primary.el.querySelector('.evidence-map-marker__cluster')?.textContent).toBe('+1');
    expect(colocated.el.dataset.clustered).toBe('hidden');
    expect(crowdedRef.lbl.dataset.collapsed).toBe('true');
  });
});
