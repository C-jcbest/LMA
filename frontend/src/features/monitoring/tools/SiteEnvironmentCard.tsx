import { useEffect, useMemo, useRef, useState } from 'react';
import { MapLayerControl } from '../MapLayerControl';
import type { SiteEnvironmentArtifactData, StationArtifact } from '@/types/envelope';
import {
  amapPosition,
  bindMapWheelZoom,
  createBaseLayers,
  DEFAULT_LAYER_SELECTION,
  mapViewOptions,
  useAMap,
  type MapLayerSelection,
} from '../basemap';
import { appendDownslopeFan, createMapMarker, createMapPopup, directionText, placeMapMarkerLabels } from '../map-markers';
import { validCoordinates, type Coordinates } from '../coordinates';

export function SiteEnvironmentCard({ environment }: { environment: SiteEnvironmentArtifactData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [layerSelection, setLayerSelection] = useState<MapLayerSelection>(DEFAULT_LAYER_SELECTION);
  const [mapError, setMapError] = useState('');
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const layerSelectionRef = useRef(layerSelection);
  layerSelectionRef.current = layerSelection;
  const stations = useMemo(() => {
    const seen = new Set<string>();
    return [environment.center_station, ...environment.group_stations].filter((station): station is StationArtifact & Coordinates => {
      const key = station.station_uuid || `${station.longitude},${station.latitude}`;
      if (!validCoordinates(station) || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [environment]);
  const center = environment.center_station;
  const aspect = environment.terrain?.aspect_degrees;
  const downslopeAzimuth = typeof aspect === 'number' && Number.isFinite(aspect) ? aspect : null;
  const invalidNames = [...new Set([center, ...environment.group_stations]
    .filter((station) => !validCoordinates(station)).map((station) => station.station_name))];

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sdk || !validCoordinates(center)) {
      return;
    }
    const layers = createBaseLayers(sdk, layerSelectionRef.current);
    layersRef.current = layers;
    const map = new sdk.Map(container, {
      layers: layers.layers,
      center: amapPosition(center),
      zoom: 15,
      zooms: [2, 20],
      ...mapViewOptions(layerSelection),
      scrollWheel: false,
      resizeEnable: true,
      dragEnable: true,
      touchZoom: true,
      rotateEnable: false,
    });
    map.addControl(new sdk.ToolBar({ position: 'RB' }));
    map.addControl(new sdk.Scale());
    const unbindWheel = bindMapWheelZoom(map, container);
    const popup = new sdk.InfoWindow({
      isCustom: true,
      autoMove: true,
      avoid: [12, 12, 24, 12],
      closeWhenClickMap: true,
      offset: new sdk.Pixel(0, -14),
    });
    const markers = stations.map((station) => {
      const isCenter = station === stations[0];
      const colorToken = isCenter ? '--foreground' : '--status-unknown';
      const role = isCenter ? '当前调查测点' : '同组监测点';
      const element = createMapMarker({
        name: station.station_name, colorToken, current: isCenter,
        detail: isCenter ? '当前调查' : (station.station_type || '同组监测点'),
        reference: station.station_type === '基准站',
      });
      if (isCenter && downslopeAzimuth !== null) {
        appendDownslopeFan(element, downslopeAzimuth);
      }
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', () => {
        const fields = [{
          label: '坐标 · WGS84', value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`, wide: true,
        }];
        if (isCenter && downslopeAzimuth !== null) {
          fields.push({ label: '下坡方向 · 约 90 m 地形', value: directionText(downslopeAzimuth), wide: true });
        }
        if (station.location) {
          fields.push({ label: '安装位置', value: station.location, wide: true });
        }
        const content = createMapPopup({
          name: station.station_name, context: role, stationType: station.station_type,
          status: station.station_status, colorToken, fields, onClose: () => popup.close(),
        }, container);
        popup.setContent(content);
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    if (markers.length > 1) {
      map.setFitView(markers.map((item) => item.marker), true, [75, 75, 75, 75], 16);
    }
    const placeLabels = () => placeMapMarkerLabels(map, container, markers);
    map.on('mapmove', placeLabels);
    map.on('zoomchange', placeLabels);
    map.on('resize', placeLabels);
    map.on('complete', placeLabels);
    const loadTimeout = window.setTimeout(() => setMapError('高德地图暂时不可用，请检查地图密钥授权和网络后刷新。'), 20000);
    map.on('complete', () => {
      window.clearTimeout(loadTimeout);
      setMapError('');
    });
    return () => {
      unbindWheel();
      window.clearTimeout(loadTimeout);
      popup.close();
      map.destroy();
      layersRef.current = null;
    };
    // 3D 开关需要重建地图；底图和道路切换在下面的 effect 里就地完成。
  }, [sdk, center, stations, downslopeAzimuth, layerSelection.terrain3d]);

  useEffect(() => {
    layersRef.current?.select(layerSelection);
  }, [layerSelection]);

  const terrain = environment.terrain;
  const geology = environment.geology;
  const faults = environment.faults;
  return (
    <div className="space-y-4">
      <MapLayerControl selection={layerSelection} onChange={setLayerSelection} />
      <div className="relative isolate overflow-hidden rounded-lg border">
        <div ref={containerRef} role="region" aria-label="场地环境地图" className="h-[min(60dvh,32rem)] w-full touch-none" />
      </div>
      {downslopeAzimuth !== null && (
        <p className="text-xs text-muted-foreground">白色虚线扇形为当前测点的下坡方向（约 90 m 地形的平均坡面，不代替现场勘查的主滑方向）</p>
      )}
      {amap.status === 'loading' && <p className="text-sm text-muted-foreground">正在加载高德地图…</p>}
      {amap.status === 'error' && <p role="status" className="text-sm text-muted-foreground">{amap.message}</p>}
      {invalidNames.length > 0 && <p className="text-sm text-muted-foreground">以下测点坐标缺失或超出经纬度范围，未绘制：{invalidNames.join('、')}。请核对平台登记坐标。</p>}
      {mapError && <p role="status" className="text-sm text-muted-foreground">{mapError}</p>}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">坐标（WGS84）</dt>
          <dd className="tabular-nums">{validCoordinates(center) ? `${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)}` : '位置缺失或坐标无效'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">地形</dt>
          <dd>
            {terrain
              ? `高程 ${terrain.dem_elevation_m ?? '—'} m · 坡度 ${terrain.slope_degrees ?? '—'}° · 坡向 ${terrain.aspect || '—'} · 500 m 起伏 ${terrain.relief_500m_m ?? '—'} m`
              : '暂无地形数据'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">地质</dt>
          <dd>{geology ? [geology.name, geology.lithology || geology.age].filter(Boolean).join(' · ') || '暂无地层名称' : '暂无地质数据'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">构造</dt>
          <dd className="wrap-break-word">{faults.note}</dd>
        </div>
      </dl>
    </div>
  );
}
