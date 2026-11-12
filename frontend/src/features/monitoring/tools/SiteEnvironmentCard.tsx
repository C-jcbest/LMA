import { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import type { SiteEnvironmentArtifactData, StationArtifact } from '@/types/envelope';
import { amapPosition, bindMapWheelZoom, createBaseLayers, useAMap, type BaseLayer } from '../basemap';
import { validCoordinates, type Coordinates } from '../coordinates';

export function SiteEnvironmentCard({ environment }: { environment: SiteEnvironmentArtifactData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('satellite');
  const [mapError, setMapError] = useState('');
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const baseLayerRef = useRef(baseLayer);
  baseLayerRef.current = baseLayer;
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
  const invalidNames = [...new Set([center, ...environment.group_stations]
    .filter((station) => !validCoordinates(station)).map((station) => station.station_name))];

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sdk || !validCoordinates(center)) {
      return;
    }
    const layers = createBaseLayers(sdk, baseLayerRef.current);
    layersRef.current = layers;
    const map = new sdk.Map(container, {
      layers: layers.layers,
      center: amapPosition(center),
      zoom: 15,
      zooms: [2, 20],
      viewMode: '2D',
      scrollWheel: false,
      resizeEnable: true,
      dragEnable: true,
      touchZoom: true,
      rotateEnable: false,
    });
    map.addControl(new sdk.ToolBar({ position: 'RB' }));
    map.addControl(new sdk.Scale());
    const unbindWheel = bindMapWheelZoom(map, container);
    const popup = new sdk.InfoWindow({ offset: new sdk.Pixel(0, -18) });
    const markers = stations.map((station) => {
      const isCenter = station.station_uuid === center.station_uuid;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `site-map-marker ${isCenter ? 'site-map-marker--center' : ''}`;
      element.setAttribute('aria-label', `${isCenter ? '当前调查站点' : '同组站点'} ${station.station_name}`);
      const dot = document.createElement('span');
      dot.className = 'site-map-marker__dot';
      const label = document.createElement('span');
      label.className = 'site-map-marker__label';
      label.textContent = station.station_name;
      element.append(dot, label);
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'bottom-center' });
      element.addEventListener('click', () => {
        const content = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = station.station_name;
        content.append(title);
        for (const text of [isCenter ? '当前调查站点' : '同组监测点', station.station_type, station.station_status, station.location]) {
          if (text) {
            const line = document.createElement('div');
            line.textContent = text;
            content.append(line);
          }
        }
        popup.setContent(content);
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    if (markers.length > 1) {
      map.setFitView(markers.map((item) => item.marker), true, [75, 75, 75, 75], 16);
    }
    const updateMarkerVisibility = () => {
      for (const { marker, element } of markers) {
        const point = map.lngLatToContainer(marker.getPosition()!);
        const halfWidth = Math.max(10, element.offsetWidth / 2);
        const height = Math.max(18, element.offsetHeight);
        const inside = point.x - halfWidth >= 4 && point.x + halfWidth <= container.clientWidth - 4
          && point.y - height >= 4 && point.y <= container.clientHeight - 4;
        element.style.visibility = inside ? 'visible' : 'hidden';
      }
    };
    map.on('mapmove', updateMarkerVisibility);
    map.on('zoomchange', updateMarkerVisibility);
    map.on('resize', updateMarkerVisibility);
    map.on('complete', updateMarkerVisibility);
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
  }, [sdk, center, stations]);

  useEffect(() => {
    layersRef.current?.select(baseLayer);
  }, [baseLayer]);

  const terrain = environment.terrain;
  const geology = environment.geology;
  const faults = environment.faults;
  return (
    <div className="space-y-4">
      <Segmented label="底图" value={baseLayer}
        options={[{ value: 'satellite', label: '卫星图' }, { value: 'road', label: '普通地图' }]}
        onValueChange={(value) => setBaseLayer(value as BaseLayer)} />
      <div className="relative isolate overflow-hidden rounded-lg border">
        <div ref={containerRef} role="region" aria-label="场地环境地图" className="h-[min(60dvh,32rem)] w-full touch-none" />
      </div>
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
