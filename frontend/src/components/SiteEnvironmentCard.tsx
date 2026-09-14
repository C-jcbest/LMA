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
import { Compass, Expand, Layers3, MapPin, Mountain, X } from 'lucide-react';
import { SiteEnvironmentArtifact, SiteStation } from '../services/api';

interface SiteEnvironmentCardProps {
  environment: SiteEnvironmentArtifact;
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

const validStations = (environment: SiteEnvironmentArtifact): SiteStation[] => {
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
  const [expanded, setExpanded] = useState(false);
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        mapRef.current?.resize();
      } catch (err) {
        console.warn('Map resize error:', err);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [expanded]);

  if (!center) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        站点缺少有效的 WGS84 经纬度，无法绘制地图。
      </div>
    );
  }

  const terrain = environment.terrain;
  const geology = environment.geology;

  return (
    <>
      {expanded && (
        <button
          key="map-backdrop"
          type="button"
          className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-[2px]"
          onClick={() => setExpanded(false)}
          aria-label="关闭展开地图"
        />
      )}
      {expanded && (
        <div key="map-placeholder" className="h-80 rounded-xl border border-transparent" aria-hidden="true" />
      )}
      <section
        key="map-section"
        className={`overflow-hidden rounded-xl border border-stone-300 bg-[#f4f1e8] shadow-sm ${
          expanded ? 'fixed inset-4 z-[80] flex flex-col shadow-2xl sm:inset-8' : ''
        }`}
      >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-300 bg-[#252a24] px-4 py-3 text-stone-100">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide">
            <MapPin className="h-4 w-4 text-amber-400" />
            {center.station_name} · 现场环境底图
          </div>
          <div className="mt-1 font-mono text-[10px] text-stone-400">
            WGS84 {Number(center.latitude).toFixed(6)}, {Number(center.longitude).toFixed(6)}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/15 bg-black/20 p-1">
          {(['satellite', 'terrain'] as BaseLayer[]).map((layer) => (
            <button
              key={layer}
              type="button"
              onClick={() => handleToggleBaseLayer(layer)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                baseLayer === layer ? 'bg-amber-400 text-stone-950' : 'text-stone-300 hover:bg-white/10'
              }`}
            >
              {layer === 'satellite' ? '卫星' : '地形'}
            </button>
          ))}
          <button
            type="button"
            onClick={handleToggleGeology}
            className={`rounded-md px-2 py-1 text-[11px] ${
              geologyVisible ? 'bg-stone-100/20 text-white' : 'text-stone-400'
            }`}
            aria-pressed={geologyVisible}
          >
            地层
          </button>
          <button
            type="button"
            onClick={handleToggleFaults}
            className={`rounded-md px-2 py-1 text-[11px] ${
              faultsVisible ? 'bg-red-500/25 text-red-100' : 'text-stone-400'
            }`}
            aria-pressed={faultsVisible}
          >
            构造线
          </button>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="ml-1 rounded-md p-1.5 text-stone-300 hover:bg-white/10"
            aria-label={expanded ? '收起地图' : '展开地图'}
            title={expanded ? '收起地图' : '展开地图'}
          >
            {expanded ? <X className="h-4 w-4" /> : <Expand className="h-3.5 w-3.5" />}
          </button>
        </div>
      </header>

      <div className={`relative isolate overflow-hidden ${expanded ? 'min-h-0 flex-1' : ''}`}>
        <div ref={mapNodeRef} className={`w-full ${expanded ? 'h-full' : 'h-80'}`} />
        <div className="pointer-events-none absolute left-3 top-3 max-w-[15rem] rounded-lg border border-white/40 bg-stone-950/80 px-3 py-2 text-[10px] text-stone-100 shadow-lg backdrop-blur-sm">
          <div className="font-semibold text-amber-300">当前关注：{center.station_name}</div>
          <div className="mt-1 text-stone-200">{stations.length > 1 ? `同组另有 ${stations.length - 1} 个有效测点，可点击标记查看` : '当前仅有该站点具备有效坐标'}</div>
          {center.station_status && <div className="mt-1 text-stone-300">设备状态：{center.station_status}</div>}
        </div>
      </div>
      {mapError && <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800">{mapError}</div>}

      <div className="grid gap-px border-t border-stone-300 bg-stone-300 sm:grid-cols-3">
        <div className="bg-[#faf8f1] p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">
            <Mountain className="h-3.5 w-3.5" />地形
          </div>
          <div className="mt-1.5 text-xs text-stone-800">
            高程 {terrain?.dem_elevation_m ?? '—'} m · 坡度 {terrain?.slope_degrees ?? '—'}°
          </div>
          <div className="mt-1 text-[10px] text-stone-500">
            坡向 {terrain?.aspect || '—'} · 500 m 起伏 {terrain?.relief_500m_m ?? '—'} m
          </div>
        </div>
        <div className="bg-[#faf8f1] p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">
            <Layers3 className="h-3.5 w-3.5" />地质
          </div>
          <div className="mt-1.5 text-xs text-stone-800">{geology?.name || '公开图层未返回地层名称'}</div>
          <div className="mt-1 text-[10px] text-stone-500">{geology?.lithology || geology?.age || '岩性/年代暂无数据'}</div>
        </div>
        <div className="bg-[#faf8f1] p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">
            <Compass className="h-3.5 w-3.5" />图层与测点
          </div>
          <div className="mt-1.5 text-xs text-stone-800">同组 {stations.length} 个有效坐标测点</div>
          <div className="mt-1 text-[10px] text-stone-500">金色为当前站点 · 浅色为同组站点</div>
        </div>
      </div>

      {(environment.limitations || []).length > 0 && (
        <details className="border-t border-stone-300 bg-[#ece8dc] px-3 py-2 text-[10px] text-stone-600">
          <summary className="cursor-pointer font-medium text-stone-700">资料限制</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {environment.limitations?.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </details>
      )}
    </section>
    </>
  );
};
