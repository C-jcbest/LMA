import { useEffect, useRef, useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { amapPosition, bindMapWheelZoom, createBaseLayers, useAMap, type BaseLayer } from './basemap';
import { validCoordinates } from './coordinates';

export interface MapStation {
  id: string;
  name: string;
  stationType: string | null;
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
  station.stationType === '基准站' || station.northMillimeters === null || station.eastMillimeters === null
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
  if (station.stationType === '基准站') {
    appendLine(node, '基准站，仅提供差分基准', 'evidence-map-popup__muted');
  } else if (magnitude !== null) {
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

/** 测点名称、状态和位移方向独立于底图图层。 */
function createMarkerNode(station: MapStation, largestMillimeters: number) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'evidence-map-marker';
  node.style.setProperty('--marker-color', `var(${station.colorToken})`);
  node.setAttribute('aria-label', station.stationType === '基准站' ? `${station.name} 基准站位置` : `${station.name} 位置与位移`);

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
  if (station.stationType === '基准站') {
    const type = document.createElement('span');
    type.className = 'evidence-map-marker__value';
    type.textContent = '基准站';
    label.append(type);
  } else if (magnitude !== null) {
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
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('satellite');
  const baseLayerRef = useRef(baseLayer);
  baseLayerRef.current = baseLayer;
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const [mapError, setMapError] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    const located = stations.filter(validCoordinates);
    if (!container || !sdk || located.length === 0) {
      return;
    }
    const layers = createBaseLayers(sdk, baseLayerRef.current);
    layersRef.current = layers;
    const map = new sdk.Map(container, {
      layers: layers.layers,
      center: amapPosition(located[0]!),
      zoom: 16,
      zooms: [2, 20],
      viewMode: '2D',
      scrollWheel: false,
      resizeEnable: true,
      dragEnable: true,
      touchZoom: true,
      // 位移箭头以屏幕正上方为北，保持地图北向上。
      rotateEnable: false,
    });
    map.addControl(new sdk.ToolBar({ position: 'RB' }));
    map.addControl(new sdk.Scale());
    const unbindWheel = bindMapWheelZoom(map, container);
    const popup = new sdk.InfoWindow({ offset: new sdk.Pixel(0, -14) });
    const largest = Math.max(0, ...located.map((station) => horizontalMillimeters(station) ?? 0));
    const markers = located.map((station) => {
      const element = createMarkerNode(station, largest);
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', () => {
        popup.setContent(createPopupNode(station, (id) => onSelectRef.current(id)));
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    map.setFitView(markers.map((item) => item.marker), true, [72, 72, 72, 72], 16);

    const placeLabels = () => {
      for (const { marker, element } of markers) {
        const label = element.querySelector<HTMLElement>('.evidence-map-marker__label');
        if (!label) {
          continue;
        }
        const x = map.lngLatToContainer(marker.getPosition()!).x;
        const roomOnRight = container.clientWidth - x - LABEL_EDGE_MARGIN;
        const roomOnLeft = x - LABEL_EDGE_MARGIN;
        element.classList.toggle('evidence-map-marker--label-start', label.offsetWidth + LABEL_GAP > roomOnRight && roomOnLeft > roomOnRight);
      }
    };
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
  }, [stations, sdk]);

  useEffect(() => {
    layersRef.current?.select(baseLayer);
  }, [baseLayer]);

  return (
    <div className="space-y-2">
      <Segmented label="底图" value={baseLayer}
        options={[{ value: 'satellite', label: '卫星图' }, { value: 'road', label: '普通地图' }]}
        onValueChange={(value) => setBaseLayer(value as BaseLayer)} />
      <div ref={containerRef} role="region" aria-label="测点位置与水平位移方向" className="h-72 w-full touch-none overflow-hidden rounded-lg bg-muted/40" />
      <p className="text-xs text-muted-foreground">北向上 · 箭头表示移动站水平位移方向，长度为相对示意</p>
      {amap.status === 'loading' && <p className="text-xs text-muted-foreground">正在加载高德地图…</p>}
      {amap.status === 'error' && <p role="status" className="text-xs text-muted-foreground">{amap.message}</p>}
      {mapError && <p role="status" className="text-xs text-muted-foreground">{mapError}</p>}
    </div>
  );
}
