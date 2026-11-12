import { useEffect, useRef, useState } from 'react';
import { MapLayerControl } from './MapLayerControl';
import { amapPosition, bindMapWheelZoom, createBaseLayers, useAMap, type MapLayerSelection } from './basemap';
import { createMapMarker, createMapPopup, placeMapMarkerLabels } from './map-markers';
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

function createPopupNode(station: MapStation, onSelect: (id: string) => void, onClose: () => void, container: HTMLElement) {
  const magnitude = horizontalMillimeters(station);
  const fields = [];
  if (magnitude !== null) {
    fields.push(
      { label: '北向分量', value: `${station.northMillimeters!.toFixed(1)} mm` },
      { label: '东向分量', value: `${station.eastMillimeters!.toFixed(1)} mm` },
    );
  }
  fields.push({ label: '坐标 · WGS84', value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`, wide: true });
  let note: string | undefined;
  if (station.stationType === '基准站') {
    note = '提供差分基准，不展示位移方向。';
  } else if (magnitude === null) {
    note = '本次没有可用的位移序列。';
  }
  return createMapPopup({
    name: station.name, context: '调查测点', stationType: station.stationType,
    status: station.status, reason: station.reason, colorToken: station.colorToken,
    metric: magnitude === null ? undefined : {
      label: station.cumulative ? '累计水平位移' : '本窗口水平变化',
      value: magnitude.toFixed(1), unit: 'mm',
      direction: magnitude > 0 ? directionText(azimuthOf(station)) : null,
    },
    fields,
    note,
    action: {
      label: '查看测点依据 →',
      run: () => {
        onClose();
        onSelect(station.id);
      },
    },
    onClose,
  }, container);
}

/** 测点名称、状态和位移方向独立于底图图层。 */
function createMarkerNode(station: MapStation, largestMillimeters: number) {
  const magnitude = horizontalMillimeters(station);
  let detail = station.stationType || '暂无位移数据';
  if (magnitude !== null) {
    detail = `${station.cumulative ? '累计' : '窗口'} ${magnitude.toFixed(1)} mm`;
    if (magnitude > 0) {
      detail += ` · ${DIRECTIONS[Math.round(azimuthOf(station) / 45) % DIRECTIONS.length]}`;
    }
  }
  const node = createMapMarker({
    name: station.name, detail, colorToken: station.colorToken,
    reference: station.stationType === '基准站',
  });
  if (magnitude !== null && magnitude > 0 && largestMillimeters > 0) {
    const arrow = document.createElement('span');
    arrow.className = 'evidence-map-marker__arrow';
    const length = MIN_ARROW_PIXELS + (MAX_ARROW_PIXELS - MIN_ARROW_PIXELS) * (magnitude / largestMillimeters);
    arrow.style.height = `${length}px`;
    // 屏幕坐标中正北朝上，方位角即旋转角。
    arrow.style.transform = `rotate(${azimuthOf(station)}deg)`;
    node.append(arrow);
  }

  return node;
}

export default function StationMap({ stations, onSelect }: { stations: readonly MapStation[]; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [layerSelection, setLayerSelection] = useState<MapLayerSelection>({ baseLayer: 'satellite', showRoads: false });
  const layerSelectionRef = useRef(layerSelection);
  layerSelectionRef.current = layerSelection;
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const [mapError, setMapError] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    const located = stations.filter(validCoordinates);
    if (!container || !sdk || located.length === 0) {
      return;
    }
    const layers = createBaseLayers(sdk, layerSelectionRef.current);
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
    const popup = new sdk.InfoWindow({
      isCustom: true,
      autoMove: true,
      avoid: [12, 12, 24, 12],
      closeWhenClickMap: true,
      offset: new sdk.Pixel(0, -14),
    });
    const largest = Math.max(0, ...located.map((station) => horizontalMillimeters(station) ?? 0));
    const markers = located.map((station) => {
      const element = createMarkerNode(station, largest);
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', () => {
        popup.setContent(createPopupNode(station, (id) => onSelectRef.current(id), () => popup.close(), container));
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    map.setFitView(markers.map((item) => item.marker), true, [72, 72, 72, 72], 16);

    const placeLabels = () => placeMapMarkerLabels(map, container, markers);
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
    layersRef.current?.select(layerSelection);
  }, [layerSelection]);

  return (
    <div className="space-y-2">
      <MapLayerControl selection={layerSelection} onChange={setLayerSelection} />
      <div ref={containerRef} role="region" aria-label="测点位置与水平位移方向" className="h-[min(65dvh,28rem)] min-h-96 w-full touch-none overflow-hidden rounded-lg bg-muted/40" />
      <p className="text-xs text-muted-foreground">北向上 · 箭头表示移动站水平位移方向，长度为相对示意</p>
      {amap.status === 'loading' && <p className="text-xs text-muted-foreground">正在加载高德地图…</p>}
      {amap.status === 'error' && <p role="status" className="text-xs text-muted-foreground">{amap.message}</p>}
      {mapError && <p role="status" className="text-xs text-muted-foreground">{mapError}</p>}
    </div>
  );
}
