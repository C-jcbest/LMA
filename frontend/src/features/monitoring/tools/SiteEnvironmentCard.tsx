import { useEffect, useMemo, useRef, useState } from 'react';
import { ToggleGroup } from 'radix-ui';
import type { SiteEnvironmentArtifactData, StationArtifact } from '@/types/envelope';
import { amapPosition, bindMapWheelZoom, createBaseLayers, useAMap, type BaseLayer } from '../basemap';
import { validCoordinates, type Coordinates } from '../coordinates';
import { createGeologyLayer } from '../geology-layer';

export function SiteEnvironmentCard({ environment }: { environment: SiteEnvironmentArtifactData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('satellite');
  const [geologyVisible, setGeologyVisible] = useState(false);
  const [faultsVisible, setFaultsVisible] = useState(true);
  const [faultsInView, setFaultsInView] = useState<boolean | null>(null);
  const [mapError, setMapError] = useState('');
  const [layerError, setLayerError] = useState('');
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const geologyRef = useRef<ReturnType<typeof createGeologyLayer> | null>(null);
  const configRef = useRef({ baseLayer, geologyVisible, faultsVisible });
  configRef.current = { baseLayer, geologyVisible, faultsVisible };
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
    const layers = createBaseLayers(sdk, configRef.current.baseLayer);
    layersRef.current = layers;
    const map = new sdk.Map(container, {
      layers: layers.layers, center: amapPosition(center), zoom: 15, zooms: [2, 20],
      viewMode: '2D', scrollWheel: false, resizeEnable: true,
      dragEnable: window.matchMedia('(pointer: fine)').matches,
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
        for (const text of [isCenter ? '当前调查站点' : '同组监测点', station.station_status, station.location]) {
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
    const geology = createGeologyLayer(sdk, map, setLayerError, setFaultsInView);
    geology.select({ geology: configRef.current.geologyVisible, faults: configRef.current.faultsVisible });
    geologyRef.current = geology;
    return () => {
      unbindWheel();
      window.clearTimeout(loadTimeout);
      geology.destroy();
      popup.close();
      map.destroy();
      layersRef.current = null;
      geologyRef.current = null;
    };
  }, [sdk, center, stations]);

  useEffect(() => {
    layersRef.current?.select(baseLayer);
    geologyRef.current?.select({ geology: geologyVisible, faults: faultsVisible });
  }, [baseLayer, geologyVisible, faultsVisible]);

  const terrain = environment.terrain;
  const geology = environment.geology;
  const faults = environment.faults;
  const layerToggleClass = 'min-h-8 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup.Root type="single" aria-label="底图" value={baseLayer} className="flex gap-1"
          onValueChange={(value) => {
            if (value) {
              setBaseLayer(value as BaseLayer);
            }
          }}>
          <ToggleGroup.Item value="satellite" className={layerToggleClass}>影像</ToggleGroup.Item>
          <ToggleGroup.Item value="road" className={layerToggleClass}>路网</ToggleGroup.Item>
        </ToggleGroup.Root>
        <div className="flex gap-1">
          <button type="button" onClick={() => setGeologyVisible((value) => !value)} aria-pressed={geologyVisible} className={layerToggleClass}>地层（区域图）</button>
          <button type="button" onClick={() => setFaultsVisible((value) => !value)} aria-pressed={faultsVisible} className={layerToggleClass}>构造线</button>
        </div>
      </div>
      <div className="relative isolate overflow-hidden rounded-lg border">
        <div ref={containerRef} role="region" aria-label="场地环境地图" className="h-[min(60dvh,32rem)] w-full" />
      </div>
      {amap.status === 'loading' && <p className="text-sm text-muted-foreground">正在加载高德地图…</p>}
      {amap.status === 'error' && <p role="status" className="text-sm text-muted-foreground">{amap.message}</p>}
      {invalidNames.length > 0 && <p className="text-sm text-muted-foreground">以下测点坐标缺失或超出经纬度范围，未绘制：{invalidNames.join('、')}。请核对平台登记坐标。</p>}
      {faultsVisible && faultsInView === false && <p className="text-sm text-muted-foreground">当前视野内没有已收录的构造线；Macrostrat 区域地质图在该地区精度有限，不代表现场没有断层。</p>}
      {geologyVisible && <p className="text-sm text-muted-foreground">地层为小比例尺区域地质图，放大后的边界不代表现场实际界线。</p>}
      <p className="text-xs text-muted-foreground">区域地质资料 © Macrostrat（CC BY 4.0）</p>
      {mapError && <p role="status" className="text-sm text-muted-foreground">{mapError}</p>}
      {layerError && <p role="status" className="text-sm text-muted-foreground">{layerError}</p>}
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
