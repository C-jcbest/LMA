import React, { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap, NavigationControl, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Compass, Expand, Layers3, MapPin, Mountain, Shrink } from 'lucide-react';
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
        'fill-color': ['coalesce', ['get', 'color'], '#b7a273'],
        'fill-opacity': 0.28,
        'fill-outline-color': 'rgba(58, 48, 32, 0.35)',
      },
    },
    {
      id: 'fault-lines',
      type: 'line',
      source: 'geology',
      'source-layer': 'lines',
      paint: { 'line-color': '#d43f2f', 'line-width': 1.6, 'line-opacity': 0.85 },
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
      zoom: 13,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');

    map.on('load', () => {
      const features = stations.map((station) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [station.longitude as number, station.latitude as number],
        },
        properties: {
          name: station.station_name,
          group: station.group_name || '',
          isCenter: station.station_uuid === environment.center_station.station_uuid,
        },
      }));
      map.addSource('stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
      });
      map.addLayer({
        id: 'group-stations',
        type: 'circle',
        source: 'stations',
        filter: ['!=', ['get', 'isCenter'], true],
        paint: {
          'circle-radius': 5,
          'circle-color': '#f7f3e8',
          'circle-stroke-color': '#252a24',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'center-station',
        type: 'circle',
        source: 'stations',
        filter: ['==', ['get', 'isCenter'], true],
        paint: {
          'circle-radius': 8,
          'circle-color': '#f2ad3a',
          'circle-stroke-color': '#171a17',
          'circle-stroke-width': 2.5,
        },
      });

      if (stations.length > 1) {
        const bounds = new LngLatBounds();
        stations.forEach((station) =>
          bounds.extend([station.longitude as number, station.latitude as number])
        );
        map.fitBounds(bounds, { padding: 55, maxZoom: 15, duration: 0 });
      }
    });
    map.on('error', (event: { error?: unknown }) => {
      console.warn('site map resource error:', event.error);
      setMapError('部分地图图层暂时不可用，站点与已获取的环境数据仍可查看。');
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [environment.center_station.station_uuid]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.setLayoutProperty('satellite-base', 'visibility', baseLayer === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('terrain-base', 'visibility', baseLayer === 'terrain' ? 'visible' : 'none');
  }, [baseLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.setLayoutProperty('geology-units', 'visibility', geologyVisible ? 'visible' : 'none');
    map.setLayoutProperty('fault-lines', 'visibility', faultsVisible ? 'visible' : 'none');
  }, [geologyVisible, faultsVisible]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.resize(), 180);
    return () => window.clearTimeout(timer);
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
    <section className="overflow-hidden rounded-xl border border-stone-300 bg-[#f4f1e8] shadow-sm">
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
              onClick={() => setBaseLayer(layer)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                baseLayer === layer ? 'bg-amber-400 text-stone-950' : 'text-stone-300 hover:bg-white/10'
              }`}
            >
              {layer === 'satellite' ? '卫星' : '地形'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setGeologyVisible((value) => !value)}
            className={`rounded-md px-2 py-1 text-[11px] ${
              geologyVisible ? 'bg-stone-100/20 text-white' : 'text-stone-400'
            }`}
            aria-pressed={geologyVisible}
          >
            地层
          </button>
          <button
            type="button"
            onClick={() => setFaultsVisible((value) => !value)}
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
            {expanded ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
          </button>
        </div>
      </header>

      <div ref={mapNodeRef} className={`w-full transition-[height] duration-200 ${expanded ? 'h-[34rem]' : 'h-72'}`} />
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
          <div className="mt-1 text-[10px] text-stone-500">地层半透明叠加 · 红线为公开构造线</div>
        </div>
      </div>

      {(environment.limitations || []).length > 0 && (
        <details className="border-t border-stone-300 bg-[#ece8dc] px-3 py-2 text-[10px] text-stone-600">
          <summary className="cursor-pointer font-medium text-stone-700">数据来源与限制</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {environment.limitations?.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
          <div className="mt-2">高程：Open-Meteo / Copernicus DEM GLO-90；地质：Macrostrat CC BY 4.0。</div>
        </details>
      )}
    </section>
  );
};
