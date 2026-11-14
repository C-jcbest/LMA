import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronDownIcon, Maximize2Icon } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { ToolArtifactEnvelopeFor } from '@/types/envelope';
import { useChartColors } from './chartColors';
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
} from './timeline';
import { ComputationResultView } from './tools/ComputationResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const EvidenceChart = lazy(() => import('./EvidenceChart'));
const StationMap = lazy(() => import('./StationMap'));

const CARD_KINDS = new Set(['gnss_series', 'computation', 'weather', 'site_environment']);

/** 能在正文中显示卡片的依据：成功取得且有可展示内容。 */
export const hasEvidenceCard = (step: InvestigationStep) =>
  step.state === 'complete' && Boolean(step.evidenceId) && step.notice === undefined
  && step.envelope !== undefined && CARD_KINDS.has(step.envelope.kind);

const STATUS_COLOR_TOKENS: Record<string, string> = {
  需人工复核: '--status-critical',
  持续关注: '--status-attention',
  未见明显变化: '--status-normal',
};

/** 场地依据里该测点的下坡方向；只有以它为中心查询过场地环境时才有。 */
const downslopeAzimuthOf = (station: StationEvidence) => {
  for (const site of [...station.site].reverse()) {
    const aspect = site.data.terrain?.aspect_degrees;
    if (site.data.center_station.station_uuid === station.uuid && typeof aspect === 'number' && Number.isFinite(aspect)) {
      return aspect;
    }
  }
  return null;
};

/** 同组但本次没有取得位移的测点，作为地图上的位置参照；单测点调查时尤其需要。 */
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

/** 有位置的调查测点画在地图上，同组其他测点作灰色参照。 */
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

/** 卡片进入视口附近才挂载图表或地图，长对话不会一次创建几十个画布。 */
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

/**
 * 依据卡片是正文的附图：标题行整体可以收起，放大入口只在悬停或聚焦时出现，平时只看到标题和图。
 * 卡片紧跟引用它的段落，编号已在句末，标题行不再重复。
 */
const CardShell: FC<CardShellProps> = ({ title, meta, onOpen, children, defaultExpanded = true }) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  return (
    <figure data-slot="evidence-card" data-state={isOpen ? 'open' : 'closed'} className="evidence-card not-prose">
      <figcaption className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sm font-medium">{title}</span>
            {meta && <span className="ms-2 text-xs text-muted-foreground tabular-nums">{meta}</span>}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !isOpen && '-rotate-90')}
          />
        </button>
        {onOpen && (
          <button type="button" onClick={onOpen} aria-label={`展开${title}`} title={`展开${title}`}
            className="evidence-card-open inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Maximize2Icon className="size-4" aria-hidden />
          </button>
        )}
      </figcaption>
      {isOpen && <div className="pt-1">{children}</div>}
    </figure>
  );
};

const SeriesChart: FC<{ station: StationEvidence; envelope: ToolArtifactEnvelopeFor<'gnss_series'> }> = ({ station, envelope }) => {
  const colors = useChartColors();
  const data = envelope.data;
  // 流式输出时每个字都会重建依据数组；按依据编号判断内容是否变化，避免逐字重绘图表。
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
    // 正文里不缩放，去掉滑块并收回为它预留的底部空间。
    const { dataZoom, brush, toolbox, ...preview } = full;
    return {
      ...preview,
      // 正文预览不拦截触屏滚动，也不显示与展开视图不同的交互控件。
      silent: true,
      tooltip: { show: false },
      legend: { ...(full.legend as object), selectedMode: false },
      grid: hasRainfall
        ? [{ left: 48, right: 12, top: 40, bottom: 112 }, { left: 48, right: 12, height: 56, bottom: 28 }]
        : [{ left: 48, right: 12, top: 40, bottom: 28 }],
    };
  }, [data, rainfall, hasRainfall, colors]);
  let height = 240;
  if (hasRainfall) {
    height = 260;
  } else if (narrow) {
    height = 200;
  }
  return (
    <WhenVisible minHeight={height}>
      <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
        <EvidenceChart option={option} label={`${data.station_name} ${seriesLabel(data)} 位移曲线`} height={height} />
      </Suspense>
    </WhenVisible>
  );
};

const StepCard: FC<{ step: InvestigationStep; station: StationEvidence | undefined; onOpen?: () => void; defaultExpanded: boolean }> = ({ step, station, onOpen, defaultExpanded }) => {
  const envelope = step.envelope!;
  switch (envelope.kind) {
    case 'gnss_series': {
      return (
        <CardShell title={`${envelope.data.station_name} 位移`} meta={`${seriesLabel(envelope.data)} · ${displacementBasis(envelope.data) === 'fixed' ? '累计位移' : '窗口内变化'}`} onOpen={onOpen} defaultExpanded={defaultExpanded}>
          {station ? <SeriesChart station={station} envelope={envelope} /> : null}
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
          <WeatherResultView data={envelope.data} />
        </CardShell>
      );
    case 'site_environment':
      return (
        <CardShell title={`${envelope.data.center_station.station_name} 场地环境`} onOpen={onOpen}>
          <WhenVisible minHeight={320}>
            <SiteEnvironmentResultView environment={envelope.data} />
          </WhenVisible>
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
  // 地图只在测点、位置、变化或状态改变时重建，流式输出不触发重绘。
  const mapKey = JSON.stringify(mapContentOf(stations, conclusionsByStation));
  const { stations: mapStations, references } = useMemo(() => JSON.parse(mapKey) as MapContent, [mapKey]);
  if (mapStations.length === 0) {
    return null;
  }
  return (
    <CardShell
      title="测点位置"
      meta={mapStations.every((station) => station.cumulative) ? '箭头为最新累计水平位移方向' : '箭头为水平位移方向；无固定参考的测点为本窗口变化'}
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

/** 正文中依据卡片的入口：按卡片编号找到本条回答里的依据。 */
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
  // 同一测点的额外窗口先显示标题，避免多张相似曲线打断阅读；用户仍可独立展开。
  const hasEarlierSeries = step.envelope?.kind === 'gnss_series' && steps.some((candidate) => (
    candidate.stationId === step.stationId && candidate.envelope?.kind === 'gnss_series'
    && (numbers.get(candidate.evidenceId ?? '') ?? Infinity) < (citationNumber ?? Infinity)
  ));
  // 正文已经用表格列出计算结果时，计算卡片只留标题行供核对，不再展开第二张表。
  const isComputationBesideTable = besideTable && step.envelope?.kind === 'computation';
  return <StepCard step={step} station={station} onOpen={onOpen} defaultExpanded={!hasEarlierSeries && !isComputationBesideTable} />;
};
