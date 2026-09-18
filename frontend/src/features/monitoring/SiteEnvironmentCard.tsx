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
import { Compass, Expand, Layers3, Mountain, X } from 'lucide-react';
import type { SiteEnvironmentArtifact, SiteStation } from '../../components/toolArtifacts';

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

      const updateMarkerVisibility = () => {
        try {
          if (!map || !mapRef.current) return;
          const container = map.getContainer();
          if (!container) return;
          const { clientWidth, clientHeight } = container;
          for (const marker of markersRef.current) {
            const pos = map.project(marker.getLngLat());
            const element = marker.getElement();
            if (!element) continue;
            const labelNode = element.querySelector('.site-map-marker__label') as HTMLElement | null;
            const halfW = (labelNode ? labelNode.offsetWidth : element.offsetWidth || 40) / 2;
            const height = element.offsetHeight || 30;
            const isOutside =
              pos.x - halfW < 0 ||
              pos.x + halfW > clientWidth ||
              pos.y - height < 0 ||
              pos.y > clientHeight;
            element.style.visibility = isOutside ? 'hidden' : 'visible';
          }
        } catch {}
      };

      map.on('move', updateMarkerVisibility);
      map.on('zoom', updateMarkerVisibility);
      map.once('idle', updateMarkerVisibility);
    }

    if (stations.length > 1) {
      const bounds = new LngLatBounds();
      for (const s of stations) bounds.extend([s.longitude as number, s.latitude as number]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
    }

    map.on('error', () => {
      setMapError('部分外部地图或地质图层不可用，已保留已确认的测点与本地事实');
    });

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = [];
    };
  }, [center?.station_uuid]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    try {
      map.setLayoutProperty('satellite-base', 'visibility', baseLayer === 'satellite' ? 'visible' : 'none');
      map.setLayoutProperty('terrain-base', 'visibility', baseLayer === 'terrain' ? 'visible' : 'none');
      map.setLayoutProperty('geology-units', 'visibility', geologyVisible ? 'visible' : 'none');
      map.setLayoutProperty('fault-lines', 'visibility', faultsVisible ? 'visible' : 'none');
    } catch {}
  }, [baseLayer, geologyVisible, faultsVisible]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      mapRef.current?.resize();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  if (!center) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
        当前测点无经纬度数据，无法加载现场环境地图。
      </div>
    );
  }

  const { terrain, geology } = environment;

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs"
          onClick={() => setExpanded(false)}
        />
      )}
      <section
        className={`overflow-hidden rounded-2xl border border-stone-300 bg-[#f4f1ea] text-stone-900 shadow-sm transition-all duration-300 ${
          expanded
            ? 'fixed inset-4 z-50 flex flex-col shadow-2xl md:inset-8'
            : 'relative max-w-3xl'
        }`}
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-300 bg-[#ece8dc] px-3.5 py-2">
          <div className="flex items-center gap-2">
            <Mountain className="h-4 w-4 text-stone-700" />
            <span className="text-xs font-bold tracking-tight text-stone-800">
              {center.station_name} · 现场环境与地质特征
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            <div className="inline-flex rounded-md border border-stone-300 bg-[#faf8f1] p-0.5">
              <button
                type="button"
                className={`cursor-pointer rounded px-2 py-0.5 font-medium transition-colors ${
                  baseLayer === 'satellite' ? 'bg-stone-800 text-stone-100 shadow-xs' : 'text-stone-600 hover:text-stone-900'
                }`}
                onClick={() => setBaseLayer('satellite')}
              >
                卫星影像
              </button>
              <button
                type="button"
                className={`cursor-pointer rounded px-2 py-0.5 font-medium transition-colors ${
                  baseLayer === 'terrain' ? 'bg-stone-800 text-stone-100 shadow-xs' : 'text-stone-600 hover:text-stone-900'
                }`}
                onClick={() => setBaseLayer('terrain')}
              >
                等高线地形
              </button>
            </div>
            <button
              type="button"
              className={`cursor-pointer rounded border border-stone-300 px-2 py-1 font-medium transition-colors ${
                geologyVisible ? 'bg-stone-800 text-stone-100' : 'bg-[#faf8f1] text-stone-600 hover:text-stone-900'
              }`}
              onClick={() => setGeologyVisible(!geologyVisible)}
            >
              地质岩性
            </button>
            <button
              type="button"
              className={`cursor-pointer rounded border border-stone-300 px-2 py-1 font-medium transition-colors ${
                faultsVisible ? 'bg-stone-800 text-stone-100' : 'bg-[#faf8f1] text-stone-600 hover:text-stone-900'
              }`}
              onClick={() => setFaultsVisible(!faultsVisible)}
            >
              断层构造
            </button>
            <button
              type="button"
              className="cursor-pointer rounded border border-stone-300 bg-[#faf8f1] p-1 text-stone-600 transition-colors hover:bg-stone-200"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? '退出全屏' : '展开全屏'}
            >
              {expanded ? <X className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
            </button>
          </div>
        </header>

        <div className={`relative isolate overflow-hidden ${expanded ? 'min-h-0 flex-1' : ''}`}>
          <div ref={mapNodeRef} className={`w-full ${expanded ? 'h-full' : 'h-80'}`} />
          <div className="pointer-events-none absolute left-3 top-3 max-w-[15rem] rounded-lg border border-white/40 bg-stone-950/80 px-3 py-2 text-[10px] text-stone-100 shadow-lg backdrop-blur-xs">
            <div className="font-semibold text-amber-300">当前关注：{center.station_name}</div>
            <div className="mt-1 text-stone-200">
              {stations.length > 1 ? `同组另有 ${stations.length - 1} 个有效测点，可点击标记查看` : '当前仅有该站点具备有效坐标'}
            </div>
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
SiteEnvironmentCard.displayName = 'SiteEnvironmentCard';
