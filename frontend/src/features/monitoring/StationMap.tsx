import { useEffect, useRef } from 'react';
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(mapWorkerUrl);

export interface MapStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** 本次依据最长窗口的水平净变化（mm）；没有序列时不画方向。 */
  northMillimeters: number | null;
  eastMillimeters: number | null;
  /** 状态色对应的 CSS 变量名，没有调查状态时为中性色。 */
  colorToken: string;
}

const TOPO_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    terrain: {
      type: 'raster',
      tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors · SRTM | OpenTopoMap (CC-BY-SA)',
    },
  },
  layers: [{ id: 'terrain-base', type: 'raster', source: 'terrain' }],
};

const MAX_ARROW_PIXELS = 44;
const MIN_ARROW_PIXELS = 12;

const horizontalMillimeters = (station: MapStation) =>
  station.northMillimeters === null || station.eastMillimeters === null
    ? null
    : Math.hypot(station.northMillimeters, station.eastMillimeters);

/** 测点标记不依赖底图瓦片：瓦片失败时点位、名称和方向仍然可见。 */
function createMarkerNode(station: MapStation, largestMillimeters: number, onSelect: (id: string) => void) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'evidence-map-marker';
  node.style.setProperty('--marker-color', `var(${station.colorToken})`);
  const magnitude = horizontalMillimeters(station);
  node.setAttribute('aria-label', `查看 ${station.name} 的依据`);

  if (magnitude !== null && magnitude > 0 && largestMillimeters > 0) {
    const arrow = document.createElement('span');
    arrow.className = 'evidence-map-marker__arrow';
    const length = MIN_ARROW_PIXELS + (MAX_ARROW_PIXELS - MIN_ARROW_PIXELS) * (magnitude / largestMillimeters);
    // 屏幕坐标中正北朝上：东向分量取正角度，北向取向上。
    const bearing = Math.atan2(station.eastMillimeters!, station.northMillimeters!) * (180 / Math.PI);
    arrow.style.height = `${length}px`;
    arrow.style.transform = `rotate(${bearing}deg)`;
    node.append(arrow);
  }

  const dot = document.createElement('span');
  dot.className = 'evidence-map-marker__dot';
  const label = document.createElement('span');
  label.className = 'evidence-map-marker__label';
  label.textContent = magnitude === null ? station.name : `${station.name} · ${magnitude.toFixed(1)} mm`;
  node.append(dot, label);
  node.addEventListener('click', () => onSelect(station.id));
  return node;
}

export default function StationMap({ stations, onSelect }: { stations: readonly MapStation[]; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || stations.length === 0) {
      return;
    }
    const bounds = new LngLatBounds();
    for (const station of stations) {
      bounds.extend([station.longitude, station.latitude]);
    }
    const map = new MapLibreMap({
      container,
      style: TOPO_STYLE,
      bounds,
      fitBoundsOptions: { padding: 64, maxZoom: 16 },
      attributionControl: { compact: true },
      // 地图嵌在滚动的正文里：滚轮和触屏单指都留给页面滚动，缩放用按钮或双指。
      scrollZoom: false,
      dragPan: window.matchMedia('(pointer: fine)').matches,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    const largest = Math.max(0, ...stations.map((station) => horizontalMillimeters(station) ?? 0));
    const markers = stations.map((station) => new Marker({
      element: createMarkerNode(station, largest, (id) => onSelectRef.current(id)),
      anchor: 'center',
    }).setLngLat([station.longitude, station.latitude]).addTo(map));

    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          map.resize();
        }
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
      }
      markers.forEach((marker) => marker.remove());
      map.remove();
    };
  }, [stations]);

  return <div ref={containerRef} role="region" aria-label="测点位置与水平位移方向" className="h-72 w-full overflow-hidden rounded-lg" />;
}
