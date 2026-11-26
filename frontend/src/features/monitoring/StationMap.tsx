import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { cn } from 'cn';
import { useTheme } from '@/app/providers/ThemeProvider';
import { MorphIcon } from '@/components/ui/motion-primitives';
import { useMediaQuery } from '@/hooks/use-media-query';
import { MapLayerControl, MapStationSheet, MapZoomControls, type ClusterOption, type MapSheetInfo } from './MapLayerControl';
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
} from './basemap';
import {
  appendDownslopeFan,
  azimuthDifference,
  azimuthOf,
  createMapMarker,
  directionName,
  directionText,
  placeMapMarkerLabels,
  setDisplacementArrow,
  setMarkerDetail,
  type PlaceableMarker,
} from './map-markers';
import { validCoordinates } from './coordinates';
import type { HorizontalSample } from './timeline';

export interface MapStation {
  id: string;
  name: string;
  stationType: string | null;
  latitude: number;
  longitude: number;
  northMillimeters: number | null;
  eastMillimeters: number | null;
  cumulative: boolean;
  downslopeAzimuth: number | null;
  track: HorizontalSample[];
  status: string | null;
  reason: string | null;
  colorToken: string;
}

export interface ReferenceStation {
  id: string;
  name: string;
  stationType: string | null;
  latitude: number;
  longitude: number;
}

const MAX_ARROW_PIXELS = 42;
const MIN_ARROW_PIXELS = 14;
const PLAYBACK_FRAMES = 100;
const PLAYBACK_INTERVAL_MS = 110;
const SEPARABLE_COORD_DEG = 0.00018;

const isBaseStation = (station: { stationType: string | null }) => station.stationType === '基准站';

const arrowLength = (magnitude: number, largest: number) =>
  MIN_ARROW_PIXELS + (MAX_ARROW_PIXELS - MIN_ARROW_PIXELS) * (magnitude / largest);

const compactDisplacementDetail = (north: number, east: number) => {
  const magnitude = Math.hypot(north, east);
  return magnitude > 0 ? `${magnitude.toFixed(1)}mm ${directionName(azimuthOf(north, east))}` : '0.0mm';
};

const stationPriority = (station: MapStation) => {
  if (station.colorToken === '--status-critical') return 40;
  if (station.colorToken === '--status-attention') return 30;
  if (!isBaseStation(station) && station.northMillimeters !== null && station.eastMillimeters !== null) return 20;
  return 15;
};

function slopeField(station: MapStation, displacementAzimuth: number | null) {
  if (station.downslopeAzimuth === null) {
    return null;
  }
  const value = displacementAzimuth === null
    ? directionText(station.downslopeAzimuth)
    : `${directionText(station.downslopeAzimuth)} · 与位移夹角 ${Math.round(azimuthDifference(displacementAzimuth, station.downslopeAzimuth))}°`;
  return { label: '下坡方向（约 90 m 坡面）', value, wide: true };
}

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

interface SelectionState {
  activeKey: string;
  clusterKeys: string[];
}

export default function StationMap({ stations, references = [], onSelect, selectLabel = '查看测点依据 →', framed = true }: {
  stations: readonly MapStation[];
  references?: readonly ReferenceStation[];
  onSelect: (id: string) => void;
  selectLabel?: string;
  framed?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMap.Map | null>(null);
  const allMarkersRef = useRef<AMap.Marker[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const { resolvedTheme } = useTheme();
  const isCompact = useMediaQuery('(max-width: 639px)');
  const amap = useAMap();
  const sdk = amap.status === 'ready' ? amap.sdk : null;
  const [layerSelection, setLayerSelection] = useState<MapLayerSelection>(DEFAULT_LAYER_SELECTION);
  const layerSelectionRef = useRef(layerSelection);
  layerSelectionRef.current = layerSelection;
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const layersRef = useRef<ReturnType<typeof createBaseLayers> | null>(null);
  const markerNodesRef = useRef(new Map<string, HTMLElement>());
  const [mapError, setMapError] = useState('');
  const [selection, setSelection] = useState<SelectionState | null>(null);

  const timeline = useMemo(() => playbackTimeline(stations), [stations]);
  const lastFrame = Math.max(0, timeline.length - 1);
  const [frame, setFrame] = useState(lastFrame);
  const [isPlaying, setIsPlaying] = useState(false);
  const largestOverTime = useMemo(() => Math.max(0, ...stations.flatMap((station) => (
    isBaseStation(station) ? [] : station.track.map((sample) => Math.hypot(sample.north, sample.east))
  ))), [stations]);

  useEffect(() => {
    setFrame(lastFrame);
    setIsPlaying(false);
  }, [lastFrame]);

  const safeFrame = Math.max(0, Math.min(frame, lastFrame));
  const currentTime = timeline.length > 1 ? timeline[safeFrame] : undefined;

  const fitAllMarkers = useCallback(() => {
    const map = mapRef.current;
    const markers = allMarkersRef.current;
    if (!map || markers.length === 0) return;
    map.setFitView(markers, false, [64, 64, 64, 64], 16);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const located = stations.filter(validCoordinates);
    if (!container || !sdk || located.length === 0 || container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }
    const layers = createBaseLayers(sdk, layerSelectionRef.current);
    layersRef.current = layers;
    const map = new sdk.Map(container, {
      layers: layers.layers,
      center: amapPosition(located[0]!),
      zoom: 16,
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
    const largest = Math.max(0, ...located.map((station) => (
      isBaseStation(station) || station.northMillimeters === null || station.eastMillimeters === null
        ? 0
        : Math.hypot(station.northMillimeters, station.eastMillimeters)
    )));
    markerNodesRef.current.clear();

    const markerByKey = new Map<string, { marker: AMap.Marker; lat: number; lng: number }>();

    const handleMarkerClick = (key: string, element: HTMLElement) => {
      const clusterKeys = (element.dataset.clusterIds ?? '').split(',').filter(Boolean);
      if (clusterKeys.length > 1) {
        const entries = clusterKeys.map((k) => markerByKey.get(k)).filter((v): v is NonNullable<typeof v> => Boolean(v));
        const lats = entries.map((e) => e.lat);
        const lngs = entries.map((e) => e.lng);
        const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
        if (span > SEPARABLE_COORD_DEG && map.getZoom() < 18) {
          setSelection(null);
          map.setFitView(entries.map((e) => e.marker), false, [72, 72, 72, 72], 18);
          return;
        }
        setSelection({ activeKey: clusterKeys[0]!, clusterKeys });
        return;
      }
      setSelection({ activeKey: key, clusterKeys: [key] });
    };

    const markers: PlaceableMarker[] = located.map((station) => {
      const key = `station:${station.id}`;
      const hasDisplacement = !isBaseStation(station) && station.northMillimeters !== null && station.eastMillimeters !== null;
      const element = createMapMarker({
        name: station.name,
        detail: hasDisplacement ? compactDisplacementDetail(station.northMillimeters!, station.eastMillimeters!) : (isBaseStation(station) ? '基准站' : ''),
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
      markerByKey.set(key, { marker, lat: station.latitude, lng: station.longitude });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        handleMarkerClick(key, element);
      });
      marker.setMap(map);
      return { marker, element, id: key, priority: stationPriority(station), isPrimary: true };
    });

    const referenceMarkers: PlaceableMarker[] = references.filter(validCoordinates).map((station) => {
      const key = `ref:${station.id}`;
      const element = createMapMarker({
        name: station.name,
        detail: isBaseStation(station) ? '基准站' : '',
        colorToken: '--status-unknown',
        reference: isBaseStation(station),
      });
      element.classList.add('evidence-map-marker--context');
      const position = amapPosition(station);
      const marker = new sdk.Marker({ position, content: element, anchor: 'center' });
      markerByKey.set(key, { marker, lat: station.latitude, lng: station.longitude });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        handleMarkerClick(key, element);
      });
      marker.setMap(map);
      return { marker, element, id: key, priority: isBaseStation(station) ? 8 : 5, isPrimary: false };
    });

    const allMarkers = [...markers, ...referenceMarkers];
    allMarkersRef.current = allMarkers.map((item) => item.marker);
    map.setFitView(allMarkersRef.current, true, [64, 64, 64, 64], 16);

    let destroyed = false;
    const placeLabels = () => {
      if (destroyed || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      placeMapMarkerLabels(map, container, allMarkers);
    };
    const onComplete = () => {
      if (destroyed) return;
      window.clearTimeout(loadTimeout);
      setMapError('');
      placeLabels();
    };
    const onMapClick = () => setSelection(null);
    map.on('click', onMapClick);
    map.on('mapmove', placeLabels);
    map.on('moveend', placeLabels);
    map.on('zoomchange', placeLabels);
    map.on('zoomend', placeLabels);
    map.on('resize', placeLabels);
    const loadTimeout = window.setTimeout(() => setMapError('高德地图暂时不可用，请检查地图密钥授权和网络后刷新。'), 20000);
    map.on('complete', onComplete);
    return () => {
      destroyed = true;
      unbindWheel();
      window.clearTimeout(loadTimeout);
      map.off('click', onMapClick);
      map.off('mapmove', placeLabels);
      map.off('moveend', placeLabels);
      map.off('zoomchange', placeLabels);
      map.off('zoomend', placeLabels);
      map.off('resize', placeLabels);
      map.off('complete', onComplete);
      map.destroy();
      mapRef.current = null;
      allMarkersRef.current = [];
      layersRef.current = null;
      markerNodesRef.current.clear();
    };
  }, [stations, references, sdk]);

  useEffect(() => {
    layersRef.current?.select(layerSelection);
    if (mapRef.current) {
      applyMapStyle(mapRef.current, layerSelection.baseLayer, resolvedTheme);
    }
  }, [layerSelection, resolvedTheme]);

  useEffect(() => {
    if (!currentTime) {
      return;
    }
    for (const station of stations) {
      const element = markerNodesRef.current.get(station.id);
      if (!element || isBaseStation(station) || station.track.length === 0) {
        continue;
      }
      const sample = sampleAt(station.track, currentTime);
      if (!sample) {
        setDisplacementArrow(element, null);
        setMarkerDetail(element, '');
        continue;
      }
      const magnitude = Math.hypot(sample.north, sample.east);
      setDisplacementArrow(element, magnitude > 0 && largestOverTime > 0
        ? { azimuth: azimuthOf(sample.north, sample.east), lengthPixels: arrowLength(magnitude, largestOverTime) }
        : null);
      setMarkerDetail(element, compactDisplacementDetail(sample.north, sample.east));
    }
  }, [currentTime, stations, largestOverTime, sdk]);

  useEffect(() => {
    if (!isPlaying) return;
    if (safeFrame >= lastFrame) {
      setIsPlaying(false);
      return;
    }
    const step = Math.max(1, Math.ceil(timeline.length / PLAYBACK_FRAMES));
    const timer = window.setTimeout(() => setFrame(Math.min(lastFrame, safeFrame + step)), PLAYBACK_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isPlaying, safeFrame, timeline.length, lastFrame]);

  const togglePlayback = () => {
    if (!isPlaying && safeFrame >= lastFrame) {
      setFrame(0);
    }
    setIsPlaying((value) => !value);
  };

  const clusterOptions = useMemo<ClusterOption[]>(() => {
    if (!selection || selection.clusterKeys.length <= 1) return [];
    return selection.clusterKeys.flatMap((key) => {
      if (key.startsWith('station:')) {
        const station = stations.find((item) => item.id === key.slice('station:'.length));
        return station ? [{ id: key, name: station.name, colorToken: station.colorToken }] : [];
      }
      const refStation = references.find((item) => item.id === key.slice('ref:'.length));
      return refStation ? [{ id: key, name: refStation.name, colorToken: '--status-unknown' }] : [];
    });
  }, [selection, stations, references]);

  const sheetInfo = useMemo<MapSheetInfo | null>(() => {
    if (!selection) return null;
    const key = selection.activeKey;
    if (key.startsWith('ref:')) {
      const refStation = references.find((item) => item.id === key.slice('ref:'.length));
      if (!refStation) return null;
      return {
        id: key,
        name: refStation.name,
        context: '同组参照',
        stationType: refStation.stationType,
        colorToken: '--status-unknown',
        fields: [{ label: '坐标（WGS84）', value: `${refStation.latitude.toFixed(6)}, ${refStation.longitude.toFixed(6)}`, wide: true }],
        note: '本次未读取该测点的位移序列。',
      };
    }
    const station = stations.find((item) => item.id === key.slice('station:'.length));
    if (!station) return null;
    const liveSample = currentTime && !isBaseStation(station) && station.track.length > 0
      ? sampleAt(station.track, currentTime)
      : null;
    const north = liveSample ? liveSample.north : station.northMillimeters;
    const east = liveSample ? liveSample.east : station.eastMillimeters;
    const hasDisplacement = !isBaseStation(station) && north !== null && east !== null;
    const magnitude = hasDisplacement ? Math.hypot(north!, east!) : null;
    const displacementAzimuth = magnitude ? azimuthOf(north!, east!) : null;
    const fields: MapSheetInfo['fields'] = [];
    if (hasDisplacement) {
      fields.push(
        { label: '北向分量', value: `${north!.toFixed(1)} mm` },
        { label: '东向分量', value: `${east!.toFixed(1)} mm` },
      );
    }
    const slope = slopeField(station, displacementAzimuth);
    if (slope) fields.push(slope);
    fields.push({ label: '坐标（WGS84）', value: `${station.latitude.toFixed(6)}, ${station.longitude.toFixed(6)}`, wide: true });
    let note: string | undefined;
    if (isBaseStation(station)) {
      note = '提供差分基准，不展示位移方向。';
    } else if (!hasDisplacement) {
      note = '暂无可用位移序列。';
    }
    return {
      id: key,
      name: station.name,
      context: '调查测点',
      stationType: station.stationType,
      colorToken: station.colorToken,
      status: station.status,
      reason: station.reason,
      metric: magnitude === null ? undefined : {
        label: station.cumulative ? '累计水平位移' : '本窗口水平变化',
        value: magnitude.toFixed(1),
        unit: 'mm',
        direction: displacementAzimuth === null ? null : directionText(displacementAzimuth),
      },
      fields,
      note,
      action: {
        label: selectLabel,
        run: () => {
          setSelection(null);
          onSelectRef.current(station.id);
        },
      },
    };
  }, [selection, stations, references, currentTime, selectLabel]);

  const hasSlope = stations.some((station) => station.downslopeAzimuth !== null);
  const hasBase = stations.some((station) => isBaseStation(station)) || references.some((station) => isBaseStation(station));
  const hasContextPeer = references.some((station) => !isBaseStation(station));
  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const [min, max] = map.getZooms();
    map.setZoom(Math.max(min, Math.min(max, map.getZoom() + delta)), false);
  };

  return (
    <div className={framed ? 'space-y-2' : undefined}>
      <div
        data-map-basemap={layerSelection.baseLayer}
        className={cn(
          'overflow-hidden bg-card',
          framed && 'rounded-xl border border-border/70',
        )}
      >
        <div className="relative isolate bg-muted/40">
          <div
            ref={containerRef}
            role="region"
            aria-label="测点位置与水平位移方向"
            aria-busy={amap.status === 'loading'}
            className={cn('h-[min(56dvh,25rem)] min-h-76 w-full touch-none', amap.status === 'loading' && 'animate-pulse')}
          />

          <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-end">
            <MapLayerControl selection={layerSelection} onChange={setLayerSelection} />
          </div>

          <div className="pointer-events-none absolute end-3 bottom-3 z-20">
            <MapZoomControls
              onZoomIn={() => zoomBy(1)}
              onZoomOut={() => zoomBy(-1)}
              onFitView={fitAllMarkers}
            />
          </div>

          {!isCompact && (
            <MapStationSheet
              info={sheetInfo}
              clusterOptions={clusterOptions}
              activeClusterId={selection?.activeKey}
              onSelectClusterMember={(activeKey) => setSelection((prev) => (prev ? { ...prev, activeKey } : null))}
              onClose={() => setSelection(null)}
            />
          )}
        </div>

        {timeline.length > 1 && (
          <div
            data-map-overlay=""
            className="flex items-center gap-2.5 border-t border-border/70 bg-card px-3 py-2"
          >
            <button
              type="button"
              onClick={togglePlayback}
              aria-label={isPlaying ? '暂停位移回放' : '播放位移回放'}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MorphIcon activeKey={isPlaying ? 'pause' : 'play'}>
                {isPlaying ? <PauseIcon className="size-3.5" aria-hidden /> : <PlayIcon className="size-3.5 translate-x-px" aria-hidden />}
              </MorphIcon>
            </button>
            <input
              type="range"
              min={0}
              max={lastFrame}
              value={safeFrame}
              aria-label="位移回放时刻"
              onChange={(event) => {
                setIsPlaying(false);
                setFrame(Number(event.target.value));
              }}
              className="min-w-0 flex-1 accent-primary"
            />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {currentTime?.slice(5, 16) ?? ''}
            </span>
          </div>
        )}

        {isCompact && (
          <MapStationSheet
            docked
            info={sheetInfo}
            clusterOptions={clusterOptions}
            activeClusterId={selection?.activeKey}
            onSelectClusterMember={(activeKey) => setSelection((prev) => (prev ? { ...prev, activeKey } : null))}
            onClose={() => setSelection(null)}
          />
        )}
      </div>

      <ul
        aria-label="地图图例"
        className={cn(
          'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground',
          framed ? 'px-0.5' : 'border-t border-border/60 bg-muted/25 px-3 py-2',
        )}
      >
        <li className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border border-background bg-foreground/75" aria-hidden />
          移动站
        </li>
        {hasBase && (
          <li className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rotate-45 rounded-xs border border-background bg-status-unknown" aria-hidden />
            基准站
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="M8 14V3M8 3l-4 4M8 3l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          水平位移
        </li>
        {hasSlope && (
          <li className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="M8 14L3 3A12 12 0 0 1 13 3Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeDasharray="2 1.5" /></svg>
            下坡方向
          </li>
        )}
        {hasContextPeer && (
          <li className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-status-unknown bg-transparent" aria-hidden />
            同组参照
          </li>
        )}
      </ul>
      {amap.status === 'error' && <p role="status" className={cn('text-xs text-muted-foreground', !framed && 'px-3 pb-2')}>{amap.message}</p>}
      {mapError && <p role="status" className={cn('text-xs text-muted-foreground', !framed && 'px-3 pb-2')}>{mapError}</p>}
    </div>
  );
}
