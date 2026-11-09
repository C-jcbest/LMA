import React, { useEffect, useRef, useState } from 'react';
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ToggleGroup } from 'radix-ui';
import type { SiteEnvironmentArtifactData, StationArtifact } from '@/types/envelope';

interface SiteEnvironmentCardProps {
  environment: SiteEnvironmentArtifactData;
}

type BaseLayer = 'satellite' | 'terrain';

const GEOLOGY_TILES = 'https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt';

const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Imagery © Esri',
    },
    terrain: {
      type: 'raster',
      tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors · SRTM | OpenTopoMap (CC-BY-SA)',
    },
    geology: {
      type: 'vector',
      tiles: [GEOLOGY_TILES],
      minzoom: 0,
      maxzoom: 5,
      attribution: 'Geology © Macrostrat (CC BY 4.0)',
    },
  },
  layers: [
    { id: 'satellite-base', type: 'raster', source: 'satellite' },
    { id: 'terrain-base', type: 'raster', source: 'terrain', layout: { visibility: 'none' } },
    {
      id: 'geology-units',
      type: 'fill',
      source: 'geology',
      'source-layer': 'units',
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], '#d4b483'],
        'fill-opacity': 0.35,
        'fill-outline-color': 'rgba(40, 30, 20, 0.45)',
      },
    },
    {
      id: 'fault-lines',
      type: 'line',
      source: 'geology',
      'source-layer': 'lines',
      paint: {
        'line-color': '#e11d48',
        'line-width': 2.8,
        'line-opacity': 0.95,
      },
    },
  ],
};

const validStations = (environment: SiteEnvironmentArtifactData): StationArtifact[] => {
  const candidates = [environment.center_station, ...(environment.group_stations || [])];
  const seen = new Set<string>();
  return candidates.filter((station) => {
    if (!station || !Number.isFinite(station.longitude) || !Number.isFinite(station.latitude)) return false;
    const key = station.station_uuid || `${station.longitude},${station.latitude}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const SiteEnvironmentCard: React.FC<SiteEnvironmentCardProps> = ({ environment }) => {
  const mapNodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('satellite');
  const [geologyVisible, setGeologyVisible] = useState(true);
  const [faultsVisible, setFaultsVisible] = useState(true);
  const [mapError, setMapError] = useState('');
  const stations = validStations(environment);
  const center = stations[0];

  useEffect(() => {
    if (!mapNodeRef.current || !center) return;

    const map = new MapLibreMap({
      container: mapNodeRef.current,
      style: BASE_STYLE,
      center: [center.longitude as number, center.latitude as number],
      zoom: 15,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');

    // MapLibre 默认只监听窗口变化；分隔线拖动只改变容器，需主动同步画布尺寸。
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        const container = mapNodeRef.current;
        if (container && container.clientWidth > 0 && container.clientHeight > 0) {
          map.resize();
        }
      });
    });
    observer.observe(mapNodeRef.current);

    // DOM Marker 不依赖底图/地质瓦片加载完成；辅助图层失败时测点仍应立即可见。
    {
      markersRef.current = stations.map((station) => {
        const isCenter = station.station_uuid === environment.center_station.station_uuid;
        const markerNode = document.createElement('button');
        markerNode.type = 'button';
        markerNode.className = `site-map-marker ${isCenter ? 'site-map-marker--center' : ''}`;
        markerNode.setAttribute('aria-label', `${isCenter ? '当前调查站点' : '同组站点'} ${station.station_name}`);
        markerNode.innerHTML = `<span class="site-map-marker__dot"></span><span class="site-map-marker__label"></span>`;
        const label = markerNode.querySelector('.site-map-marker__label');
        if (label) label.textContent = station.station_name;
        const popupNode = document.createElement('div');
        const popupTitle = document.createElement('strong');
        popupTitle.textContent = station.station_name;
        popupNode.append(popupTitle);
        for (const text of [
          isCenter ? '当前调查站点' : '同组监测点',
          station.station_status ? `状态：${station.station_status}` : '',
          station.location || '',
        ]) {
          if (!text) continue;
          const line = document.createElement('div');
          line.textContent = text;
          popupNode.append(line);
        }
        const popup = new Popup({ offset: 18, closeButton: true }).setDOMContent(popupNode);
        return new Marker({ element: markerNode, anchor: 'bottom' })
          .setLngLat([station.longitude as number, station.latitude as number])
          .setPopup(popup)
          .addTo(map);
      });

      // Marker 是独立 DOM，地理点在边缘时标签会跨过地图边框。根据实际标签尺寸
      // 在每次平移/缩放后做可视区裁决，边缘点直接隐藏而不覆盖外框。
      const updateMarkerVisibility = () => {
        try {
          if (!map || !mapRef.current) return;
          const container = map.getContainer();
          if (!container) return;
          const width = container.clientWidth;
          const height = container.clientHeight;
          if (width === 0 || height === 0) return;
          for (const marker of markersRef.current) {
            const point = map.project(marker.getLngLat());
            const element = marker.getElement();
            const rect = element.getBoundingClientRect();
            const halfWidth = Math.max(10, rect.width / 2);
            const markerHeight = Math.max(18, rect.height);
            const inside =
              point.x - halfWidth >= 4 &&
              point.x + halfWidth <= width - 4 &&
              point.y - markerHeight >= 4 &&
              point.y <= height - 4;
            element.style.visibility = inside ? 'visible' : 'hidden';
          }
        } catch (err) {
          console.warn('updateMarkerVisibility error:', err);
        }
      };
      map.on('move', updateMarkerVisibility);
      map.on('resize', updateMarkerVisibility);
      map.once('idle', updateMarkerVisibility);

      if (stations.length > 1) {
        const bounds = new LngLatBounds();
        stations.forEach((station) =>
          bounds.extend([station.longitude as number, station.latitude as number])
        );
        map.fitBounds(bounds, { padding: 75, maxZoom: 16, duration: 0 });
      }
      window.requestAnimationFrame(updateMarkerVisibility);
    }
    map.on('load', () => applyLayerVisibilities(map));

    map.on('error', (event: { error?: unknown }) => {
      console.warn('site map resource error:', event.error);
      setMapError('部分地图图层暂时不可用，站点与已获取的环境数据仍可查看。');
    });

    return () => {
      observer.disconnect();
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
      }
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [environment.center_station.station_uuid]);

  // 保持对最新图层配置的引用
  const layerConfigRef = useRef({ baseLayer, geologyVisible, faultsVisible });
  layerConfigRef.current = { baseLayer, geologyVisible, faultsVisible };

  const applyLayerVisibilities = (mapInstance?: MapLibreMap | null) => {
    const map = mapInstance || mapRef.current;
    if (!map) return;
    const { baseLayer: currentBase, geologyVisible: currentGeology, faultsVisible: currentFaults } = layerConfigRef.current;

    const setVisibilityIfChanged = (layerId: string, targetVisibility: 'visible' | 'none') => {
      try {
        if (map.getLayer(layerId)) {
          const current = map.getLayoutProperty(layerId, 'visibility') || 'visible';
          if (current !== targetVisibility) {
            map.setLayoutProperty(layerId, 'visibility', targetVisibility);
          }
        }
      } catch (err) {
        console.warn(`Failed to update visibility for layer ${layerId}:`, err);
      }
    };

    setVisibilityIfChanged('satellite-base', currentBase === 'satellite' ? 'visible' : 'none');
    setVisibilityIfChanged('terrain-base', currentBase === 'terrain' ? 'visible' : 'none');
    setVisibilityIfChanged('geology-units', currentGeology ? 'visible' : 'none');
    setVisibilityIfChanged('fault-lines', currentFaults ? 'visible' : 'none');
  };

  useEffect(() => {
    applyLayerVisibilities();
  }, [baseLayer, geologyVisible, faultsVisible]);

  const handleToggleBaseLayer = (layer: BaseLayer) => {
    setBaseLayer(layer);
  };

  const handleToggleGeology = () => {
    setGeologyVisible((prev) => !prev);
  };

  const handleToggleFaults = () => {
    setFaultsVisible((prev) => !prev);
  };

  if (!center) {
    return <p className="text-sm text-muted-foreground">站点缺少有效的 WGS84 经纬度，无法绘制地图。</p>;
  }

  const terrain = environment.terrain;
  const geology = environment.geology;
  const faults = environment.faults;
  const layerToggleClass = 'min-h-8 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup.Root
          type="single"
          aria-label="底图"
          value={baseLayer}
          onValueChange={(next) => {
            if (next) handleToggleBaseLayer(next as BaseLayer);
          }}
          className="flex gap-1"
        >
          <ToggleGroup.Item value="satellite" className={layerToggleClass}>卫星</ToggleGroup.Item>
          <ToggleGroup.Item value="terrain" className={layerToggleClass}>地形</ToggleGroup.Item>
        </ToggleGroup.Root>
        <div className="flex gap-1">
          <button type="button" onClick={handleToggleGeology} aria-pressed={geologyVisible} className={layerToggleClass}>地层</button>
          <button type="button" onClick={handleToggleFaults} aria-pressed={faultsVisible} className={layerToggleClass}>构造线</button>
        </div>
      </div>

      <div className="relative isolate overflow-hidden rounded-lg border">
        <div ref={mapNodeRef} className="h-[min(60dvh,32rem)] w-full" />
      </div>
      {mapError && <p className="text-sm text-muted-foreground">{mapError}</p>}

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">坐标（WGS84）</dt>
          <dd className="tabular-nums">{Number(center.latitude).toFixed(6)}, {Number(center.longitude).toFixed(6)}</dd>
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
};
