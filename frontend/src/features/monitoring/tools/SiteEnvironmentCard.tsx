import { cn } from 'cn';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/app/providers/ThemeProvider';
import { useMediaQuery } from '@/hooks/use-media-query';
import { MapLayerControl, MapStationSheet, MapZoomControls, type MapSheetInfo } from '../MapLayerControl';
import type { SiteEnvironmentArtifactData, StationArtifact } from '@/types/envelope';
import {
  amapPosition,
  applyMapStyle,
  bindMapWheelZoom,
  createBaseLayers,
  DEFAULT_LAYER_SELECTION,
  MAP_2D_OPTIONS,
  mapStyleFor,
  useAMap,
  type MapLayerSelection,
} from '../basemap';
import { appendDownslopeFan, createMapMarker, directionText, placeMapMarkerLabels } from '../map-markers';
import { validCoordinates, type Coordinates } from '../coordinates';

const formatGeology = (geology: SiteEnvironmentArtifactData['geology']) => {
  if (!geology) return '暂无地质数据';
  const parts: string[] = [];
  for (const part of [geology.name, geology.lithology, geology.age]) {
    const trimmed = part?.trim();
    if (!trimmed) continue;
    if (parts.some((existing) => existing === trimmed || existing.includes(trimmed))) continue;
    parts.push(trimmed);
  }
  return parts.join(' · ') || '暂无地层名称';
};

export function SiteEnvironmentCard({ environment }: { environment: SiteEnvironmentArtifactData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMap.Map | null>(null);
  const allMarkersRef = useRef<AMap.Marker[]>([]);
  const { resolvedTheme } = useTheme();
  const isCompact = useMediaQuery('(max-width: 639px)');
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [layerSelection, setLayerSelection] = useState<MapLayerSelection>(DEFAULT_LAYER_SELECTION);
  const [mapError, setMapError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const layerSelectionRef = useRef(layerSelection);
  layerSelectionRef.current = layerSelection;
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
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

  const fitAllMarkers = useCallback(() => {
    const map = mapRef.current;
    const markers = allMarkersRef.current;
    if (!map || markers.length === 0) return;
    if (markers.length > 1) {
      map.setFitView(markers, false, [64, 64, 64, 64], 16);
    } else if (validCoordinates(center)) {
      map.setZoomAndCenter(15, amapPosition(center), false);
    }
  }, [center]);

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
      mapStyle: mapStyleFor(layerSelectionRef.current.baseLayer, resolvedThemeRef.current),
      ...MAP_2D_OPTIONS,
      scrollWheel: false,
      resizeEnable: true,
      dragEnable: true,
      touchZoom: true,
      rotateEnable: false,
    });
    mapRef.current = map;
    map.addControl(new sdk.Scale());
    const unbindWheel = bindMapWheelZoom(map, container);
    const markers = stations.map((station, index) => {
      const isCenter = index === 0;
      const colorToken = isCenter ? '--foreground' : '--status-unknown';
      const element = createMapMarker({
        name: station.station_name,
        colorToken,
        current: isCenter,
        detail: isCenter ? '当前测点' : (station.station_type === '基准站' ? '基准站' : ''),
        reference: station.station_type === '基准站',
      });
      if (!isCenter && station.station_type !== '基准站') {
        element.classList.add('evidence-map-marker--context');
      }
      if (isCenter && downslopeAzimuth !== null) {
        appendDownslopeFan(element, downslopeAzimuth);
      }
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        setSelectedIndex(index);
      });
      marker.setMap(map);
      return { marker, element, id: String(index), priority: isCenter ? 30 : 5, isPrimary: isCenter };
    });
    allMarkersRef.current = markers.map((item) => item.marker);
    if (markers.length > 1) {
      map.setFitView(allMarkersRef.current, true, [64, 64, 64, 64], 16);
    }
    const placeLabels = () => placeMapMarkerLabels(map, container, markers);
    const onMapClick = () => setSelectedIndex(null);
    map.on('click', onMapClick);
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
      map.off('click', onMapClick);
      map.destroy();
      mapRef.current = null;
      allMarkersRef.current = [];
      layersRef.current = null;
    };
  }, [sdk, center, stations, downslopeAzimuth]);

  useEffect(() => {
    layersRef.current?.select(layerSelection);
    if (mapRef.current) {
      applyMapStyle(mapRef.current, layerSelection.baseLayer, resolvedTheme);
    }
  }, [layerSelection, resolvedTheme]);

  const sheetInfo = useMemo<MapSheetInfo | null>(() => {
    if (selectedIndex === null) return null;
    const station = stations[selectedIndex];
    if (!station) return null;
    const isCenter = selectedIndex === 0;
    const fields: MapSheetInfo['fields'] = [{
      label: '坐标（WGS84）',
      value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`,
      wide: true,
    }];
    if (isCenter && downslopeAzimuth !== null) {
      fields.push({ label: '下坡方向（约 90 m 坡面）', value: directionText(downslopeAzimuth), wide: true });
    }
    if (station.location) {
      fields.push({ label: '安装位置', value: station.location, wide: true });
    }
    return {
      id: `${selectedIndex}:${station.station_uuid ?? station.station_name}`,
      name: station.station_name,
      context: isCenter ? '当前调查测点' : '同组监测点',
      stationType: station.station_type,
      status: station.station_status && station.station_status !== '正常' ? station.station_status : null,
      colorToken: isCenter ? '--foreground' : '--status-unknown',
      fields,
    };
  }, [selectedIndex, stations, downslopeAzimuth]);

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const [min, max] = map.getZooms();
    map.setZoom(Math.max(min, Math.min(max, map.getZoom() + delta)), false);
  };

  const terrain = environment.terrain;
  const geology = environment.geology;
  return (
    <div className="space-y-4">
      <div
        data-map-basemap={layerSelection.baseLayer}
        className="overflow-hidden rounded-xl border border-border/70 bg-card"
      >
        <div className="relative isolate bg-muted/40">
          <div
            ref={containerRef}
            role="region"
            aria-label="场地环境地图"
            aria-busy={amap.status === 'loading'}
            className={cn('h-[min(54dvh,26rem)] min-h-72 w-full touch-none', amap.status === 'loading' && 'animate-pulse')}
          />
          <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-end">
            <MapLayerControl selection={layerSelection} onChange={setLayerSelection} />
          </div>
          <div className="pointer-events-none absolute end-3 bottom-3 z-20">
            <MapZoomControls onZoomIn={() => zoomBy(1)} onZoomOut={() => zoomBy(-1)} onFitView={fitAllMarkers} />
          </div>
          {!isCompact && <MapStationSheet info={sheetInfo} onClose={() => setSelectedIndex(null)} />}
        </div>
        {isCompact && <MapStationSheet docked info={sheetInfo} onClose={() => setSelectedIndex(null)} />}
      </div>
      {downslopeAzimuth !== null && (
        <p className="text-xs text-muted-foreground">虚线扇形为当前测点下坡方向（约 90 m 地形平均坡面，不代替现场勘查主滑方向）。</p>
      )}
      {amap.status === 'error' && <p role="status" className="text-sm text-muted-foreground">{amap.message}</p>}
      {invalidNames.length > 0 && <p className="text-sm text-muted-foreground">以下测点坐标缺失或无效，未绘制：{invalidNames.join('、')}。</p>}
      {mapError && <p role="status" className="text-sm text-muted-foreground">{mapError}</p>}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">坐标（WGS84）</dt>
          <dd className="tabular-nums">{validCoordinates(center) ? `${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)}` : '位置缺失或坐标无效'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">地形</dt>
          <dd className="tabular-nums">
            {terrain
              ? `高程 ${terrain.dem_elevation_m ?? '—'} m · 坡度 ${terrain.slope_degrees ?? '—'}° · 坡向 ${terrain.aspect || '—'} · 500 m 起伏 ${terrain.relief_500m_m ?? '—'} m`
              : '暂无地形数据'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">地质</dt>
          <dd>{formatGeology(geology)}</dd>
        </div>
      </dl>
    </div>
  );
}
