import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronDownIcon, Maximize2Icon } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
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
import { StationCompass, type CompassReading } from './StationCompass';
import { StationTimelineCard } from './StationTimelineCard';
import {
  displacementBasis,
  horizontalTrack,
  latestHorizontal,
  seriesDuration,
} from './timeline';
import { ComputationResultView } from './tools/ComputationResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const EvidenceChart = lazy(() => import('./EvidenceChart'));
const StationMap = lazy(() => import('./StationMap'));

const CARD_KINDS = new Set(['gnss_series', 'station_overview', 'computation', 'weather', 'site_environment']);
const SERIES_KINDS = new Set(['gnss_series', 'station_overview']);

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

const StepCard: FC<{ step: InvestigationStep; onOpen?: () => void; defaultExpanded: boolean }> = ({ step, onOpen, defaultExpanded }) => {
  const envelope = step.envelope!;
  switch (envelope.kind) {
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

const StationMapView: FC<{ content: MapContent; onOpenStation: (stationId: string) => void }> = ({ content, onOpenStation }) => (
  <WhenVisible minHeight={288}>
    <ErrorBoundary fallbackTitle="地图渲染异常">
      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <StationMap stations={content.stations} references={content.references} onSelect={onOpenStation} />
      </Suspense>
    </ErrorBoundary>
  </WhenVisible>
);

/** 罗盘读数来自地图同一份内容：箭头为最长窗口最新的水平位移，扇形为场地下坡方向。 */
const compassReadingOf = (station: MapStation): CompassReading | null => {
  if (station.northMillimeters === null || station.eastMillimeters === null) {
    return null;
  }
  const magnitude = Math.hypot(station.northMillimeters, station.eastMillimeters);
  if (magnitude === 0) {
    return null;
  }
  const azimuth = ((Math.atan2(station.eastMillimeters, station.northMillimeters) * 180) / Math.PI + 360) % 360;
  return { azimuth, magnitudeMillimeters: magnitude, downslopeAzimuth: station.downslopeAzimuth, cumulative: station.cumulative };
};

/**
 * 多测点时地图承担“哪几个点、在哪、往哪动”的空间对比；单测点时用户只需要方向和是否顺坡，
 * 用方向罗盘代替，地图按需打开，底图加载失败也不会留下一大块空白。
 */
const StationMapCard: FC<{ stations: readonly StationEvidence[]; onOpenStation: (stationId: string) => void }> = ({ stations, onOpenStation }) => {
  const parts = useAuiState((state) => state.message.parts);
  const [showMap, setShowMap] = useState(false);
  const conclusionsByStation = useMemo(() => {
    const conclusions = findConclusions(parts);
    return new Map((conclusions?.stations ?? []).map((item) => [item.station_uuid, { status: item.status, reason: item.reason }]));
  }, [parts]);
  // 地图只在测点、位置、变化或状态改变时重建，流式输出不触发重绘。
  const mapKey = JSON.stringify(mapContentOf(stations, conclusionsByStation));
  const content = useMemo(() => JSON.parse(mapKey) as MapContent, [mapKey]);
  if (content.stations.length === 0) {
    return null;
  }
  const single = content.stations.length === 1 ? content.stations[0]! : null;
  const reading = single ? compassReadingOf(single) : null;
  if (single && reading) {
    return (
      <CardShell title={`${single.name} 位移方向`} meta={reading.cumulative ? '最新累计水平位移' : '本窗口水平变化'}>
        <StationCompass reading={reading} />
        <button type="button" onClick={() => setShowMap((value) => !value)} aria-expanded={showMap}
          className="mt-2 min-h-8 rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {showMap ? '收起地图' : '在地图中查看'}
        </button>
        {showMap && <div className="mt-2"><StationMapView content={content} onOpenStation={onOpenStation} /></div>}
      </CardShell>
    );
  }
  return (
    <CardShell
      title="测点位置"
      meta={content.stations.every((station) => station.cumulative) ? '箭头为最新累计水平位移方向' : '箭头为水平位移方向；无固定参考的测点为本窗口变化'}
    >
      <StationMapView content={content} onOpenStation={onOpenStation} />
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
  if (step.envelope && SERIES_KINDS.has(step.envelope.kind)) {
    // 位移依据按测点合成一张时间轴卡，放在该测点第一次被引用的位置；之后的引用只切换卡内窗口。
    const station = stations.find((item) => item.id === step.stationId);
    const numbers = evidenceNumbers(parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n'));
    const citationNumber = numbers.get(cardId) ?? Infinity;
    const isFirstForStation = !steps.some((candidate) => (
      candidate.stationId === step.stationId && candidate.envelope !== undefined && SERIES_KINDS.has(candidate.envelope.kind)
      && (numbers.get(candidate.evidenceId ?? '') ?? Infinity) < citationNumber
    ));
    if (!station || !isFirstForStation) {
      return null;
    }
    return <StationTimelineCard messageId={messageId} station={station} initialToolCallId={step.toolCallId} />;
  }
  const onOpen = () => openEvidence({ messageId, stationId: step.stationId, toolCallId: step.toolCallId });
  // 正文已经用表格列出计算结果时，计算卡片只留标题行供核对，不再展开第二张表。
  const isComputationBesideTable = besideTable && step.envelope?.kind === 'computation';
  return <StepCard step={step} onOpen={onOpen} defaultExpanded={!isComputationBesideTable} />;
};
