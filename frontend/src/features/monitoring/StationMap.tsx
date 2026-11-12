import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Segmented } from '@/components/ui/segmented';
import {
  BASE_LAYER_IDS,
  MISSING_TOKEN_NOTICE,
  tiandituLayers,
  tiandituSources,
  useTiandituToken,
  type BaseLayer,
} from './basemap';

setWorkerUrl(mapWorkerUrl);

export interface MapStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** 最新水平位移（mm）：有固定参考时为累计位移，否则为本窗口变化；没有序列时为 null。 */
  northMillimeters: number | null;
  eastMillimeters: number | null;
  cumulative: boolean;
  status: string | null;
  reason: string | null;
  /** 状态色对应的 CSS 变量名，没有调查状态时为中性色。 */
  colorToken: string;
}

const MAX_ARROW_PIXELS = 44;
const MIN_ARROW_PIXELS = 14;
/** 名称与圆点的间距，以及名称距地图边缘至少留出的空白（px）。 */
const LABEL_GAP = 10;
const LABEL_EDGE_MARGIN = 8;
const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

const horizontalMillimeters = (station: MapStation) =>
  station.northMillimeters === null || station.eastMillimeters === null
    ? null
    : Math.hypot(station.northMillimeters, station.eastMillimeters);

/** 方位角从正北顺时针计，0–360°。 */
const azimuthOf = (station: MapStation) =>
  (Math.atan2(station.eastMillimeters!, station.northMillimeters!) * (180 / Math.PI) + 360) % 360;

export const directionText = (azimuth: number) => {
  const direction = DIRECTIONS[Math.round(azimuth / 45) % DIRECTIONS.length]!;
  return `${direction}（方位 ${Math.round(azimuth)}°）`;
};

const appendLine = (parent: HTMLElement, text: string, className?: string) => {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) {
    line.className = className;
  }
  parent.append(line);
};

function createPopupNode(station: MapStation, onSelect: (id: string) => void) {
  const node = document.createElement('div');
  node.className = 'evidence-map-popup';
  const title = document.createElement('strong');
  title.textContent = station.name;
  node.append(title);
  if (station.status) {
    appendLine(node, station.reason ? `${station.status}：${station.reason}` : station.status);
  }
  const magnitude = horizontalMillimeters(station);
  if (magnitude !== null) {
    const kind = station.cumulative ? '累计水平位移' : '本窗口水平变化';
    appendLine(node, `${kind} ${magnitude.toFixed(1)} mm，朝${directionText(azimuthOf(station))}`);
    appendLine(node, `北 ${station.northMillimeters!.toFixed(1)} mm · 东 ${station.eastMillimeters!.toFixed(1)} mm`, 'evidence-map-popup__muted');
  } else {
    appendLine(node, '本次没有可用的位移序列', 'evidence-map-popup__muted');
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'evidence-map-popup__action';
  button.textContent = '查看依据';
  button.addEventListener('click', () => onSelect(station.id));
  node.append(button);
  return node;
}

/** 测点标记不依赖底图瓦片：瓦片失败或未配置密钥时点位、名称和方向仍然可见。 */
function createMarkerNode(station: MapStation, largestMillimeters: number) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'evidence-map-marker';
  node.style.setProperty('--marker-color', `var(${station.colorToken})`);
  node.setAttribute('aria-label', `${station.name} 位置与位移`);

  const magnitude = horizontalMillimeters(station);
  if (magnitude !== null && magnitude > 0 && largestMillimeters > 0) {
    const arrow = document.createElement('span');
    arrow.className = 'evidence-map-marker__arrow';
    const length = MIN_ARROW_PIXELS + (MAX_ARROW_PIXELS - MIN_ARROW_PIXELS) * (magnitude / largestMillimeters);
    arrow.style.height = `${length}px`;
    // 屏幕坐标中正北朝上，方位角即旋转角。
    arrow.style.transform = `rotate(${azimuthOf(station)}deg)`;
    node.append(arrow);
  }

  const dot = document.createElement('span');
  dot.className = 'evidence-map-marker__dot';
  const label = document.createElement('span');
  label.className = 'evidence-map-marker__label';
  const name = document.createElement('span');
  name.textContent = station.name;
  label.append(name);
  if (magnitude !== null) {
    const value = document.createElement('span');
    value.className = 'evidence-map-marker__value';
    value.textContent = `${magnitude.toFixed(1)} mm ${DIRECTIONS[Math.round(azimuthOf(station) / 45) % DIRECTIONS.length]}`;
    label.append(value);
  }
  node.append(dot, label);
  return node;
}

export default function StationMap({ stations, onSelect }: { stations: readonly MapStation[]; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const tiandituToken = useTiandituToken();
  const token = tiandituToken.status === 'ready' ? tiandituToken.token : null;
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('terrain');
  const baseLayerRef = useRef(baseLayer);
  baseLayerRef.current = baseLayer;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || stations.length === 0 || tiandituToken.status === 'loading') {
      return;
    }
    const bounds = new LngLatBounds();
    for (const station of stations) {
      bounds.extend([station.longitude, station.latitude]);
    }
    const map = new MapLibreMap({
      container,
      style: {
        version: 8,
        sources: token ? tiandituSources(token) : {},
        layers: token ? tiandituLayers(baseLayerRef.current) : [],
      },
      bounds,
      fitBoundsOptions: { padding: 72, maxZoom: 16 },
      attributionControl: { compact: true },
      // 地图嵌在滚动的正文里：滚轮和触屏单指都留给页面滚动，缩放用按钮或双指。
      scrollZoom: false,
      dragPan: window.matchMedia('(pointer: fine)').matches,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    const largest = Math.max(0, ...stations.map((station) => horizontalMillimeters(station) ?? 0));
    const markers = stations.map((station) => new Marker({
      element: createMarkerNode(station, largest),
      anchor: 'center',
    })
      .setLngLat([station.longitude, station.latitude])
      .setPopup(new Popup({ offset: 14, closeButton: true, maxWidth: '18rem' })
        .setDOMContent(createPopupNode(station, (id) => onSelectRef.current(id))))
      .addTo(map));

    // 名称默认在圆点右侧；右边放不下（如窄屏靠右的测点）时改放左侧，不被地图边框裁掉。
    const placeLabels = () => {
      const width = container.clientWidth;
      for (const marker of markers) {
        const element = marker.getElement();
        const label = element.querySelector<HTMLElement>('.evidence-map-marker__label');
        if (!label) continue;
        const x = map.project(marker.getLngLat()).x;
        const roomOnRight = width - x - LABEL_EDGE_MARGIN;
        const roomOnLeft = x - LABEL_EDGE_MARGIN;
        const needed = label.offsetWidth + LABEL_GAP;
        element.classList.toggle('evidence-map-marker--label-start', needed > roomOnRight && roomOnLeft > roomOnRight);
      }
    };
    placeLabels();
    map.on('move', placeLabels);
    map.on('resize', placeLabels);

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
      mapRef.current = null;
    };
  }, [stations, tiandituToken.status, token]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !token) {
      return;
    }
    const apply = () => {
      for (const [base, layerIds] of Object.entries(BASE_LAYER_IDS)) {
        for (const layerId of layerIds) {
          if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', base === baseLayer ? 'visible' : 'none');
          }
        }
      }
    };
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
  }, [baseLayer, token]);

  return (
    <div className="space-y-2">
      {token && (
        <Segmented
          label="底图"
          value={baseLayer}
          options={[{ value: 'terrain', label: '地形' }, { value: 'satellite', label: '影像' }]}
          onValueChange={(value) => setBaseLayer(value as BaseLayer)}
        />
      )}
      <div ref={containerRef} role="region" aria-label="测点位置与水平位移方向" className="h-72 w-full overflow-hidden rounded-lg bg-muted/40" />
      {tiandituToken.status === 'ready' && !token && <p className="text-xs text-muted-foreground">{MISSING_TOKEN_NOTICE}</p>}
    </div>
  );
}
