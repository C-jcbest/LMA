import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronRightIcon } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Skeleton } from '@/components/ui/skeleton';
import type { AxisFeature, ToolArtifactEnvelopeFor } from '@/types/envelope';
import { useChartColors } from './chartColors';
import { STATION_MAP_CARD } from './evidence-cards';
import {
  buildSteps,
  collectStations,
  findConclusions,
  type InvestigationStep,
  type StationEvidence,
} from './investigation';
import type { MapStation } from './StationMap';
import { useStationInspector } from './StationInspectorContext';
import { buildTimelineOption, dailyRainfallWithin, seriesDuration, seriesLabel } from './timeline';
import { ComputationResultView } from './tools/ComputationResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const EvidenceChart = lazy(() => import('./EvidenceChart'));
const StationMap = lazy(() => import('./StationMap'));

const CARD_KINDS = new Set(['gnss_series', 'computation', 'weather', 'vision', 'site_environment']);

/** 能在正文中显示卡片的依据：成功取得且有可展示内容。 */
export const hasEvidenceCard = (step: InvestigationStep) =>
  step.state === 'complete' && Boolean(step.evidenceId) && step.notice === undefined
  && step.envelope !== undefined && CARD_KINDS.has(step.envelope.kind);

const STATUS_COLOR_TOKENS: Record<string, string> = {
  需人工复核: '--status-critical',
  持续关注: '--status-attention',
  未见明显变化: '--status-normal',
};

/** 至少两个测点有位置时，地图才比文字更能说明空间关系。 */
export const mapStationsOf = (
  stations: readonly StationEvidence[],
  statusByStation: ReadonlyMap<string, string>,
): MapStation[] => {
  const located = stations.filter((station) => station.coordinates);
  if (located.length < 2) {
    return [];
  }
  return located.map((station) => {
    const longest = [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data))[0];
    const north = longest?.data.summary.n.change;
    const east = longest?.data.summary.e.change;
    const hasHorizontal = typeof north === 'number' && typeof east === 'number';
    const status = statusByStation.get(station.id);
    return {
      id: station.id,
      name: station.name,
      latitude: station.coordinates!.latitude,
      longitude: station.coordinates!.longitude,
      // GNSS 摘要单位为 m。
      northMillimeters: hasHorizontal ? north * 1000 : null,
      eastMillimeters: hasHorizontal ? east * 1000 : null,
      colorToken: (status && STATUS_COLOR_TOKENS[status]) || '--status-unknown',
    };
  });
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

const CardShell: FC<{ title: string; meta?: string; onOpen?: () => void; children: ReactNode }> = ({ title, meta, onOpen, children }) => (
  <figure data-slot="evidence-card" className="evidence-card not-prose">
    <figcaption className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 text-sm font-medium">
        {title}
        {meta && <span className="ms-2 text-xs font-normal text-muted-foreground tabular-nums">{meta}</span>}
      </span>
      {onOpen && (
        <button type="button" onClick={onOpen}
          className="inline-flex min-h-8 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          查看依据<ChevronRightIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </figcaption>
    {children}
  </figure>
);

const SeriesChart: FC<{ station: StationEvidence; envelope: ToolArtifactEnvelopeFor<'gnss_series'> }> = ({ station, envelope }) => {
  const colors = useChartColors();
  const data = envelope.data;
  // 流式输出时每个字都会重建依据数组；按依据编号判断内容是否变化，避免逐字重绘图表。
  const weatherKey = station.weather.map((item) => item.toolCallId).join();
  const visionKey = station.vision.map((item) => item.toolCallId).join();
  const weather = useMemo(() => station.weather.map((item) => item.data), [weatherKey]);
  const vision = useMemo(() => station.vision.map((item) => item.data), [visionKey]);
  const rainfall = useMemo(
    () => dailyRainfallWithin(weather, data.begin_time, data.end_time),
    [weather, data],
  );
  const hasRainfall = rainfall.length > 0;
  const option = useMemo(() => {
    const candidates = vision
      .flatMap((item) => item.observations?.candidates ?? [])
      .filter((candidate) => candidate.end_at >= data.begin_time && candidate.start_at <= data.end_time);
    const full = buildTimelineOption({ data, rainfall, candidates, peers: [], mode: 'components' }, colors) as Record<string, unknown>;
    // 正文里不缩放，去掉滑块并收回为它预留的底部空间。
    return {
      ...full,
      dataZoom: [],
      brush: undefined,
      grid: hasRainfall
        ? [{ left: 48, right: 12, top: 40, bottom: 112 }, { left: 48, right: 12, height: 56, bottom: 28 }]
        : [{ left: 48, right: 12, top: 40, bottom: 28 }],
    };
  }, [data, rainfall, hasRainfall, vision, colors]);
  const height = hasRainfall ? 300 : 240;
  return (
    <WhenVisible minHeight={height}>
      <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
        <EvidenceChart option={option} label={`${data.station_name} ${seriesLabel(data)} 位移曲线`} height={height} />
      </Suspense>
    </WhenVisible>
  );
};

const AXIS_NAMES: Record<string, string> = { n: '北向', e: '东向', u: '垂直', h: '水平合成', d: '三维合成' };

const formatNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumSignificantDigits: 4 })
    : '未知';

/** 服务端计算的数值放在曲线下方，正文里的数字可随手对照；完整复核在依据面板。 */
const FeatureSummary: FC<{ features: Record<string, AxisFeature> }> = ({ features }) => (
  <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-3 pt-3">
    {Object.entries(features).map(([axis, feature]) => (
      <div key={axis} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{AXIS_NAMES[axis] ?? axis}</dt>
        <dd className="text-base font-medium tabular-nums">
          {formatNumber(feature.net_change_mm)}<span className="ms-1 text-xs font-normal text-muted-foreground">mm</span>
        </dd>
        <dd className="text-xs text-muted-foreground tabular-nums">
          {feature.trend_supported ? '趋势' : '描述斜率'} {formatNumber(feature.robust_slope_mm_day)} mm/day
        </dd>
      </div>
    ))}
  </dl>
);

const VisionSummary: FC<{ envelope: ToolArtifactEnvelopeFor<'vision'> }> = ({ envelope }) => {
  const candidates = envelope.data.observations?.candidates ?? [];
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">曲线未见需要复核的候选区间。</p>;
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {candidates.map((candidate, index) => (
        <li key={index} className="border-s-2 border-status-attention ps-3">
          <span className="text-muted-foreground tabular-nums">{candidate.metric} · {candidate.start_at.slice(5, 16)} 至 {candidate.end_at.slice(5, 16)}</span>
          <span className="ms-2">{candidate.description || '未描述'}</span>
        </li>
      ))}
    </ul>
  );
};

const StepCard: FC<{ step: InvestigationStep; station: StationEvidence | undefined; onOpen?: () => void }> = ({ step, station, onOpen }) => {
  const envelope = step.envelope!;
  switch (envelope.kind) {
    case 'gnss_series': {
      const features = envelope.data.features ?? {};
      return (
        <CardShell title={`${envelope.data.station_name} 位移`} meta={`曲线相对窗口首点 · ${seriesLabel(envelope.data)}`} onOpen={onOpen}>
          {station ? <SeriesChart station={station} envelope={envelope} /> : null}
          {Object.keys(features).length > 0 && <FeatureSummary features={features} />}
        </CardShell>
      );
    }
    case 'computation':
      return (
        <CardShell title={envelope.data.description} meta="基于本次已取得的数据计算">
          <ComputationResultView data={envelope.data} />
        </CardShell>
      );
    case 'vision':
      return (
        <CardShell title={`${envelope.data.station_name} 曲线复核`} meta="视觉候选，需数值复核" onOpen={onOpen}>
          <VisionSummary envelope={envelope} />
        </CardShell>
      );
    case 'weather':
      return (
        <CardShell title="同期天气" meta={envelope.data.location.station_name ?? undefined} onOpen={onOpen}>
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
  const statusByStation = useMemo(() => {
    const conclusions = findConclusions(parts);
    return new Map((conclusions?.stations ?? []).map((item) => [item.station_uuid, item.status]));
  }, [parts]);
  // 地图只在测点、位置、变化或状态改变时重建，流式输出不触发重绘。
  const mapKey = JSON.stringify(mapStationsOf(stations, statusByStation));
  const mapStations = useMemo(() => JSON.parse(mapKey) as MapStation[], [mapKey]);
  if (mapStations.length === 0) {
    return null;
  }
  return (
    <CardShell title="测点位置" meta="箭头为本次依据最长窗口的水平净变化方向">
      <WhenVisible minHeight={288}>
        <ErrorBoundary fallbackTitle="地图渲染异常">
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <StationMap stations={mapStations} onSelect={onOpenStation} />
          </Suspense>
        </ErrorBoundary>
      </WhenVisible>
    </CardShell>
  );
};

/** 正文中依据卡片的入口：按卡片编号找到本条回答里的依据。 */
export const EvidenceCard: FC<{ cardId: string }> = ({ cardId }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { openStation } = useStationInspector();
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
  const onOpen = step.stationId
    ? () => openStation({ messageId, stationId: step.stationId!, toolCallId: step.toolCallId })
    : undefined;
  return <StepCard step={step} station={station} onOpen={onOpen} />;
};
