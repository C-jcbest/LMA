import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronDownIcon, MapPinIcon, Maximize2Icon } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { SiteEnvironmentArtifactData, ToolArtifactEnvelopeFor } from '@/types/envelope';
import { useChartColors } from './chartColors';
import { timelineAskTarget } from './ask-targets';
import type { ChartSelection } from './TimelineChart';
import { evidenceNumbers, STATION_MAP_CARD } from './evidence-cards';
import {
  buildSteps,
  collectStations,
  findConclusions,
  formatDateRange,
  type InvestigationStep,
  type StationEvidence,
} from './investigation';
import type { MapStation, ReferenceStation } from './StationMap';
import { validCoordinates } from './coordinates';
import { useStationInspector } from './StationInspectorContext';
import {
  buildTimelineOption,
  dailyRainfallWithin,
  displacementBasis,
  horizontalTrack,
  latestHorizontal,
  seriesDuration,
  seriesLabel,
  seriesTitle,
} from './timeline';
import { ComputationResultView } from './tools/ComputationResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { WeatherEvidence } from './WeatherEvidence';

const TimelineChart = lazy(() => import('./TimelineChart'));
const StationMap = lazy(() => import('./StationMap'));

const CARD_KINDS = new Set(['gnss_series', 'computation', 'weather', 'site_environment']);

export const hasEvidenceCard = (step: InvestigationStep) =>
  step.state === 'complete' && Boolean(step.evidenceId) && step.notice === undefined
  && step.envelope !== undefined && CARD_KINDS.has(step.envelope.kind);

const STATUS_COLOR_TOKENS: Record<string, string> = {
  需人工复核: '--status-critical',
  持续关注: '--status-attention',
  未见明显变化: '--status-normal',
};

const downslopeAzimuthOf = (station: StationEvidence) => {
  for (const site of [...station.site].reverse()) {
    const aspect = site.data.terrain?.aspect_degrees;
    if (site.data.center_station.station_uuid === station.uuid && typeof aspect === 'number' && Number.isFinite(aspect)) {
      return aspect;
    }
  }
  return null;
};

const referenceStationsOf = (stations: readonly StationEvidence[]): ReferenceStation[] => {
  const evidenceIds = new Set(stations.map((station) => station.uuid ?? station.id));
  const references = new Map<string, ReferenceStation>();
  for (const station of stations) {
    const candidates = [
      ...station.series.flatMap((item) => item.data.location?.group_stations ?? []),
      ...station.site.flatMap((item) => item.data.group_stations),
    ];
    for (const candidate of candidates) {
      if (!candidate.station_uuid || evidenceIds.has(candidate.station_uuid) || references.has(candidate.station_uuid)
          || !validCoordinates(candidate)) {
        continue;
      }
      references.set(candidate.station_uuid, {
        id: candidate.station_uuid,
        name: candidate.station_name,
        stationType: candidate.station_type ?? null,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
      });
    }
  }
  return [...references.values()];
};

export interface MapContent {
  stations: MapStation[];
  references: ReferenceStation[];
}

export const mapContentOf = (
  stations: readonly StationEvidence[],
  conclusionsByStation: ReadonlyMap<string, { status: string; reason: string }>,
): MapContent => {
  const located = stations.filter((station) => station.coordinates);
  if (located.length === 0) {
    return { stations: [], references: [] };
  }
  const mapStations = located.map((station) => {
    const longest = [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data))[0];
    const horizontal = longest ? latestHorizontal(longest.data) : null;
    const conclusion = conclusionsByStation.get(station.id);
    return {
      id: station.id,
      name: station.name,
      stationType: station.stationType ?? null,
      latitude: station.coordinates!.latitude,
      longitude: station.coordinates!.longitude,
      northMillimeters: horizontal?.north ?? null,
      eastMillimeters: horizontal?.east ?? null,
      cumulative: longest ? displacementBasis(longest.data) === 'fixed' : false,
      downslopeAzimuth: downslopeAzimuthOf(station),
      track: longest && station.stationType !== '基准站' ? horizontalTrack(longest.data) : [],
      status: conclusion?.status ?? null,
      reason: conclusion?.reason ?? null,
      colorToken: (conclusion && STATUS_COLOR_TOKENS[conclusion.status]) || '--status-unknown',
    };
  });
  return { stations: mapStations, references: referenceStationsOf(located) };
};

const WhenVisible: FC<{ minHeight: number; children: ReactNode }> = ({ minHeight, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
      }
    }, { rootMargin: '400px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={ref} style={{ minHeight: visible ? undefined : minHeight }}>{visible && children}</div>;
};

interface CardShellProps {
  title: string;
  meta?: string;
  onOpen?: () => void;
  defaultExpanded?: boolean;
  children: ReactNode;
}

const formatGeologyText = (geology: SiteEnvironmentArtifactData['geology']) => {
  if (!geology) return '暂无地质数据';
  const uniqueParts: string[] = [];
  for (const part of [geology.name, geology.lithology, geology.age]) {
    const trimmed = part?.trim();
    if (!trimmed) continue;
    if (uniqueParts.some((existing) => existing === trimmed || existing.includes(trimmed))) continue;
    uniqueParts.push(trimmed);
  }
  return uniqueParts.join(' · ') || '暂无地层名称';
};

const CompactSiteSummary: FC<{ environment: SiteEnvironmentArtifactData; onOpenMap?: () => void }> = ({ environment, onOpenMap }) => {
  const { center_station: center, terrain, geology } = environment;
  const metrics = [
    { label: '高程', value: terrain?.dem_elevation_m != null ? `${terrain.dem_elevation_m} m` : '—' },
    { label: '坡度', value: terrain?.slope_degrees != null ? `${terrain.slope_degrees}°` : '—' },
    { label: '坡向', value: terrain?.aspect || '—' },
    { label: '500 m 起伏', value: terrain?.relief_500m_m != null ? `${terrain.relief_500m_m} m` : '—' },
  ];
  return (
    <div className="space-y-3 pt-1">
      {terrain && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          {metrics.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-2.5 text-xs text-muted-foreground">
        <div className="min-w-0 space-y-0.5">
          <p className="wrap-break-word text-foreground/90">{formatGeologyText(geology)}</p>
          {validCoordinates(center) && (
            <p className="tabular-nums">WGS84 · {center.latitude.toFixed(5)}, {center.longitude.toFixed(5)}</p>
          )}
        </div>
        {onOpenMap && (
          <Button type="button" variant="outline" size="xs" onClick={onOpenMap} className="shrink-0 gap-1.5 rounded-full">
            <MapPinIcon className="size-3.5" aria-hidden />
            查看场地地图
          </Button>
        )}
      </div>
    </div>
  );
};

const CardShell: FC<CardShellProps> = ({ title, meta, onOpen, children, defaultExpanded = true }) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
    <figure data-slot="evidence-card" className="evidence-card not-prose">
      <figcaption className="-me-1.5 flex items-center gap-1">
        <CollapsibleTrigger className="group/card flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-0.5">
            <span className="break-words text-sm font-medium">{title}</span>
            {meta && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
          </span>
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/card:text-foreground group-data-[state=closed]/card:-rotate-90"
          />
        </CollapsibleTrigger>
        {onOpen && (
          <button type="button" onClick={onOpen} aria-label={`在侧栏查看${title}`} title={`在侧栏查看${title}`}
            className="evidence-card-open inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Maximize2Icon className="size-3.5" aria-hidden />
          </button>
        )}
      </figcaption>
      <CollapsibleContent className="pt-1.5">{children}</CollapsibleContent>
    </figure>
    </Collapsible>
  );
};

const SeriesChart: FC<{ station: StationEvidence; envelope: ToolArtifactEnvelopeFor<'gnss_series'>; viewKey: string }> = ({ station, envelope, viewKey }) => {
  const { attachAskTarget, composerInputRef } = useStationInspector();
  const isThreadRunning = useAuiState((state) => state.thread.isRunning);
  const colors = useChartColors();
  const data = envelope.data;
  const weatherKey = station.weather.map((item) => item.toolCallId).join();
  const weather = useMemo(() => station.weather.map((item) => item.data), [weatherKey]);
  const rainfall = useMemo(
    () => dailyRainfallWithin(weather, data.begin_time, data.end_time),
    [weather, data],
  );
  const hasRainfall = rainfall.length > 0;
  const narrow = useMediaQuery('(max-width: 599px)');
  const option = useMemo(() => {
    const full = buildTimelineOption({ data, rainfall, peers: [], mode: 'components' }, colors) as Record<string, unknown>;
    const { dataZoom, ...inline } = full;
    return {
      ...inline,
      grid: hasRainfall
        ? [{ left: 48, right: 12, top: 44, bottom: 124 }, { left: 48, right: 12, height: 60, bottom: 28 }]
        : [{ left: 48, right: 12, top: 44, bottom: 28 }],
    };
  }, [data, rainfall, hasRainfall, colors]);

  const askAbout = (range: ChartSelection) => {
    attachAskTarget(timelineAskTarget(range, envelope, station.weather));
    composerInputRef.current?.focus();
  };

  let height = 260;
  if (hasRainfall) {
    height = 300;
  } else if (narrow) {
    height = 220;
  }
  return (
    <WhenVisible minHeight={height}>
      <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
        <TimelineChart
          viewKey={viewKey}
          option={option}
          label={`${data.station_name} ${seriesLabel(data)} 位移曲线`}
          resetSignal={0}
          onRangeChange={() => undefined}
          onAsk={askAbout}
          askDisabled={isThreadRunning}
          height={height}
          allowZoom={false}
          hasRainfall={hasRainfall}
        />
      </Suspense>
    </WhenVisible>
  );
};

const StepCard: FC<{
  step: InvestigationStep;
  station: StationEvidence | undefined;
  hasStationMap: boolean;
  onOpen?: () => void;
  defaultExpanded: boolean;
}> = ({ step, station, hasStationMap, onOpen, defaultExpanded }) => {
  const envelope = step.envelope!;
  switch (envelope.kind) {
    case 'gnss_series': {
      return (
        <CardShell title={seriesTitle(envelope.data)} meta={`${seriesLabel(envelope.data)}${displacementBasis(envelope.data) === 'fixed' ? '' : ' · 窗口内变化'}`} onOpen={onOpen} defaultExpanded={defaultExpanded}>
          {station ? <SeriesChart station={station} envelope={envelope} viewKey={step.toolCallId} /> : null}
        </CardShell>
      );
    }
    case 'computation':
      return (
        <CardShell title={envelope.data.description} meta="计算结果" onOpen={onOpen} defaultExpanded={defaultExpanded}>
          <ComputationResultView data={envelope.data} />
        </CardShell>
      );
    case 'weather':
      return (
        <CardShell
          title={`${envelope.data.location.station_name ?? ''} 同期天气`.trim()}
          meta={formatDateRange(envelope.data.query.history_start_date, envelope.data.query.history_end_date)}
          onOpen={onOpen}
        >
          <WeatherEvidence evidence={envelope} />
        </CardShell>
      );
    case 'site_environment':
      return (
        <CardShell title={`${envelope.data.center_station.station_name} 场地环境`} onOpen={onOpen}>
          {hasStationMap ? (
            <CompactSiteSummary environment={envelope.data} onOpenMap={onOpen} />
          ) : (
            <WhenVisible minHeight={320}>
              <SiteEnvironmentResultView environment={envelope.data} />
            </WhenVisible>
          )}
        </CardShell>
      );
    default:
      return null;
  }
};

const StationMapCard: FC<{ stations: readonly StationEvidence[]; onOpenStation: (stationId: string) => void }> = ({ stations, onOpenStation }) => {
  const parts = useAuiState((state) => state.message.parts);
  const conclusionsByStation = useMemo(() => {
    const conclusions = findConclusions(parts);
    return new Map((conclusions?.stations ?? []).map((item) => [item.station_uuid, { status: item.status, reason: item.reason }]));
  }, [parts]);
  const mapKey = JSON.stringify(mapContentOf(stations, conclusionsByStation));
  const { stations: mapStations, references } = useMemo(() => JSON.parse(mapKey) as MapContent, [mapKey]);
  if (mapStations.length === 0) {
    return null;
  }
  return (
    <CardShell
      title="测点位置"
      meta={mapStations.every((station) => station.cumulative) ? undefined : '无固定参考的测点为本窗口变化'}
    >
      <WhenVisible minHeight={288}>
        <ErrorBoundary fallbackTitle="地图渲染异常">
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <StationMap stations={mapStations} references={references} onSelect={onOpenStation} />
          </Suspense>
        </ErrorBoundary>
      </WhenVisible>
    </CardShell>
  );
};

export const EvidenceCard: FC<{ cardId: string; besideTable: boolean }> = ({ cardId, besideTable }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { openStation, openEvidence } = useStationInspector();
  const stations = useMemo(() => collectStations(parts), [parts]);
  const steps = useMemo(() => buildSteps(parts, stations), [parts, stations]);

  if (cardId === STATION_MAP_CARD) {
    return <StationMapCard stations={stations} onOpenStation={(stationId) => openStation({ messageId, stationId })} />;
  }
  const step = steps.find((item) => item.evidenceId === cardId && hasEvidenceCard(item));
  if (!step) {
    return null;
  }
  const station = stations.find((item) => item.id === step.stationId);
  const onOpen = () => openEvidence({ messageId, stationId: step.stationId, toolCallId: step.toolCallId });
  const numbers = evidenceNumbers(parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n'));
  const citationNumber = numbers.get(cardId);
  const hasEarlierSeries = step.envelope?.kind === 'gnss_series' && steps.some((candidate) => (
    candidate.stationId === step.stationId && candidate.envelope?.kind === 'gnss_series'
    && (numbers.get(candidate.evidenceId ?? '') ?? Infinity) < (citationNumber ?? Infinity)
  ));
  const isComputationBesideTable = besideTable && step.envelope?.kind === 'computation';
  const hasStationMap = stations.some((item) => Boolean(item.coordinates));
  return <StepCard step={step} station={station} hasStationMap={hasStationMap} onOpen={onOpen} defaultExpanded={!hasEarlierSeries && !isComputationBesideTable} />;
};
