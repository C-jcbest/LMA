import { useEffect, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MapLayerControl } from './MapLayerControl';
import {
  amapPosition,
  bindMapWheelZoom,
  createBaseLayers,
  DEFAULT_LAYER_SELECTION,
  mapViewOptions,
  useAMap,
  type MapLayerSelection,
} from './basemap';
import {
  appendDownslopeFan,
  azimuthDifference,
  azimuthOf,
  createMapMarker,
  createMapPopup,
  directionName,
  directionText,
  placeMapMarkerLabels,
  setDisplacementArrow,
  setMarkerDetail,
} from './map-markers';
import { validCoordinates } from './coordinates';
import type { HorizontalSample } from './timeline';

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
  /** 场地依据给出的下坡方向方位角；没有查询场地环境时为 null。 */
  downslopeAzimuth: number | null;
  /** 最长窗口的水平位移轨迹，用于时间回放。 */
  track: HorizontalSample[];
  status: string | null;
  reason: string | null;
  /** 状态色对应的 CSS 变量名，没有调查状态时为中性色。 */
  colorToken: string;
}

/** 同组未取得位移的测点，只作位置参照。 */
export interface ReferenceStation {
  id: string;
  name: string;
  stationType: string | null;
  latitude: number;
  longitude: number;
}

const MAX_ARROW_PIXELS = 44;
const MIN_ARROW_PIXELS = 14;
const PLAYBACK_FRAMES = 100;
const PLAYBACK_INTERVAL_MS = 120;

const isBaseStation = (station: { stationType: string | null }) => station.stationType === '基准站';

const arrowLength = (magnitude: number, largest: number) =>
  MIN_ARROW_PIXELS + (MAX_ARROW_PIXELS - MIN_ARROW_PIXELS) * (magnitude / largest);

const displacementDetail = (station: MapStation, north: number, east: number) => {
  const magnitude = Math.hypot(north, east);
  const kind = station.cumulative ? '累计' : '窗口';
  return magnitude > 0
    ? `${kind} ${magnitude.toFixed(1)} mm · ${directionName(azimuthOf(north, east))}`
    : `${kind} 0.0 mm`;
};

function slopeField(station: MapStation, displacementAzimuth: number | null) {
  if (station.downslopeAzimuth === null) {
    return null;
  }
  const value = displacementAzimuth === null
    ? directionText(station.downslopeAzimuth)
    : `${directionText(station.downslopeAzimuth)} · 与位移夹角 ${Math.round(azimuthDifference(displacementAzimuth, station.downslopeAzimuth))}°`;
  return { label: '下坡方向 · 约 90 m 地形', value, wide: true };
}

function createPopupNode(station: MapStation, onSelect: (id: string) => void, onClose: () => void, container: HTMLElement) {
  const hasDisplacement = !isBaseStation(station) && station.northMillimeters !== null && station.eastMillimeters !== null;
  const magnitude = hasDisplacement ? Math.hypot(station.northMillimeters!, station.eastMillimeters!) : null;
  const displacementAzimuth = magnitude ? azimuthOf(station.northMillimeters!, station.eastMillimeters!) : null;
  const fields = [];
  if (hasDisplacement) {
    fields.push(
      { label: '北向分量', value: `${station.northMillimeters!.toFixed(1)} mm` },
      { label: '东向分量', value: `${station.eastMillimeters!.toFixed(1)} mm` },
    );
  }
  const slope = slopeField(station, displacementAzimuth);
  if (slope) {
    fields.push(slope);
  }
  fields.push({ label: '坐标 · WGS84', value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`, wide: true });
  let note: string | undefined;
  if (isBaseStation(station)) {
    note = '提供差分基准，不展示位移方向。';
  } else if (!hasDisplacement) {
    note = '本次没有可用的位移序列。';
  }
  return createMapPopup({
    name: station.name, context: '调查测点', stationType: station.stationType,
    status: station.status, reason: station.reason, colorToken: station.colorToken,
    metric: magnitude === null ? undefined : {
      label: station.cumulative ? '累计水平位移' : '本窗口水平变化',
      value: magnitude.toFixed(1), unit: 'mm',
      direction: displacementAzimuth === null ? null : directionText(displacementAzimuth),
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

/** 回放的时间轴是各测点轨迹时刻的并集；每个测点取不晚于当前时刻的最后一个样本。 */
function playbackTimeline(stations: readonly MapStation[]) {
  return [...new Set(stations.flatMap((station) => station.track.map((sample) => sample.time)))].sort();
}

const sampleAt = (track: readonly HorizontalSample[], time: string) => {
  let latest: HorizontalSample | null = null;
  for (const sample of track) {
    if (sample.time > time) {
      break;
    }
    latest = sample;
  }
  return latest;
};

export default function StationMap({ stations, references = [], onSelect }: {
  stations: readonly MapStation[];
  references?: readonly ReferenceStation[];
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [layerSelection, setLayerSelection] = useState<MapLayerSelection>(DEFAULT_LAYER_SELECTION);
  const layerSelectionRef = useRef(layerSelection);
  layerSelectionRef.current = layerSelection;
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const markerNodesRef = useRef(new Map<string, HTMLElement>());
  const [mapError, setMapError] = useState('');

  const timeline = useMemo(() => playbackTimeline(stations), [stations]);
  const lastFrame = timeline.length - 1;
  const [frame, setFrame] = useState(lastFrame);
  const [isPlaying, setIsPlaying] = useState(false);
  // 回放用全程最大位移定箭头比例，箭头随时间变长才能看出变化。
  const largestOverTime = useMemo(() => Math.max(0, ...stations.flatMap((station) => (
    isBaseStation(station) ? [] : station.track.map((sample) => Math.hypot(sample.north, sample.east))
  ))), [stations]);

  useEffect(() => {
    setFrame(lastFrame);
    setIsPlaying(false);
  }, [lastFrame]);

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
      ...mapViewOptions(layerSelection),
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
    const largest = Math.max(0, ...located.map((station) => (
      isBaseStation(station) || station.northMillimeters === null || station.eastMillimeters === null
        ? 0
        : Math.hypot(station.northMillimeters, station.eastMillimeters)
    )));
    markerNodesRef.current.clear();
    const markers = located.map((station) => {
      const hasDisplacement = !isBaseStation(station) && station.northMillimeters !== null && station.eastMillimeters !== null;
      const element = createMapMarker({
        name: station.name,
        detail: hasDisplacement ? displacementDetail(station, station.northMillimeters!, station.eastMillimeters!) : (station.stationType || '暂无位移数据'),
        colorToken: station.colorToken,
        reference: isBaseStation(station),
      });
      if (station.downslopeAzimuth !== null) {
        appendDownslopeFan(element, station.downslopeAzimuth);
      }
      const magnitude = hasDisplacement ? Math.hypot(station.northMillimeters!, station.eastMillimeters!) : 0;
      if (magnitude > 0 && largest > 0) {
        setDisplacementArrow(element, {
          azimuth: azimuthOf(station.northMillimeters!, station.eastMillimeters!),
          lengthPixels: arrowLength(magnitude, largest),
        });
      }
      markerNodesRef.current.set(station.id, element);
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', () => {
        popup.setContent(createPopupNode(station, (id) => onSelectRef.current(id), () => popup.close(), container));
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    const referenceMarkers = references.filter(validCoordinates).map((station) => {
      const element = createMapMarker({
        name: station.name, detail: station.stationType || '同组测点', colorToken: '--status-unknown', reference: true,
      });
      element.classList.add('evidence-map-marker--context');
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      element.addEventListener('click', () => {
        popup.setContent(createMapPopup({
          name: station.name, context: '同组测点（位置参照）', stationType: station.stationType,
          colorToken: '--status-unknown',
          fields: [{ label: '坐标 · WGS84', value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`, wide: true }],
          note: '本次回答没有取得它的位移数据。',
          onClose: () => popup.close(),
        }, container));
        popup.open(map, position);
      });
      marker.setMap(map);
      return { marker, element };
    });
    const allMarkers = [...markers, ...referenceMarkers];
    map.setFitView(allMarkers.map((item) => item.marker), true, [72, 72, 72, 72], 16);

    const placeLabels = () => placeMapMarkerLabels(map, container, allMarkers);
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
      markerNodesRef.current.clear();
    };
    // 3D 开关需要重建地图；底图和道路切换在下面的 effect 里就地完成。
  }, [stations, references, sdk, layerSelection.terrain3d]);

  useEffect(() => {
    layersRef.current?.select(layerSelection);
  }, [layerSelection]);

  // 回放：把每个测点的箭头和标签更新到当前时刻；回到末帧时与静态显示一致。
  useEffect(() => {
    if (timeline.length < 2 || frame < 0) {
      return;
    }
    const time = timeline[Math.min(frame, lastFrame)]!;
    for (const station of stations) {
      const element = markerNodesRef.current.get(station.id);
      if (!element || isBaseStation(station) || station.track.length === 0) {
        continue;
      }
      const sample = sampleAt(station.track, time);
      if (!sample) {
        setDisplacementArrow(element, null);
        setMarkerDetail(element, '尚无数据');
        continue;
      }
      const magnitude = Math.hypot(sample.north, sample.east);
      setDisplacementArrow(element, magnitude > 0 && largestOverTime > 0
        ? { azimuth: azimuthOf(sample.north, sample.east), lengthPixels: arrowLength(magnitude, largestOverTime) }
        : null);
      setMarkerDetail(element, displacementDetail(station, sample.north, sample.east));
    }
  }, [frame, timeline, lastFrame, stations, largestOverTime, sdk, layerSelection.terrain3d]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    if (frame >= lastFrame) {
      setIsPlaying(false);
      return;
    }
    // 无论轨迹多长，一次完整回放约 100 帧。
    const step = Math.max(1, Math.ceil(timeline.length / PLAYBACK_FRAMES));
    const timer = window.setTimeout(() => setFrame(Math.min(lastFrame, frame + step)), PLAYBACK_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isPlaying, frame, timeline.length, lastFrame]);

  const togglePlayback = () => {
    if (!isPlaying && frame >= lastFrame) {
      setFrame(0);
    }
    setIsPlaying((value) => !value);
  };

  const hasSlope = stations.some((station) => station.downslopeAzimuth !== null);

  return (
    <div className="space-y-2">
      <MapLayerControl selection={layerSelection} onChange={setLayerSelection} />
      <div ref={containerRef} role="region" aria-label="测点位置与水平位移方向" className="h-[min(65dvh,28rem)] min-h-96 w-full touch-none overflow-hidden rounded-lg bg-muted/40" />
      {timeline.length > 1 && (
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="icon" className="size-9 shrink-0"
            aria-label={isPlaying ? '暂停位移回放' : '播放位移回放'} onClick={togglePlayback}>
            {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
          </Button>
          <input
            type="range"
            min={0}
            max={lastFrame}
            value={Math.min(frame, lastFrame)}
            aria-label="位移回放时刻"
            onChange={(event) => {
              setIsPlaying(false);
              setFrame(Number(event.target.value));
            }}
            className="min-w-0 flex-1 accent-primary"
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {timeline[Math.min(frame, lastFrame)]!.slice(5, 16)}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        北向上 · 箭头表示移动站水平位移方向，长度为相对示意
        {hasSlope && ' · 白色虚线扇形为下坡方向（约 90 m 地形的平均坡面）'}
        {references.length > 0 && ' · 灰点为同组测点位置'}
        {layerSelection.terrain3d && ' · 3D 下箭头为屏幕示意'}
      </p>
      {amap.status === 'loading' && <p className="text-xs text-muted-foreground">正在加载高德地图…</p>}
      {amap.status === 'error' && <p role="status" className="text-xs text-muted-foreground">{amap.message}</p>}
      {mapError && <p role="status" className="text-xs text-muted-foreground">{mapError}</p>}
    </div>
  );
}
