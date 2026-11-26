import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react';
import { useOptionalSetFocusStation } from '@/app/providers/LmaClientContext';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import type { EvidenceSource, GnssArtifactData, ToolArtifactEnvelope } from '@/types/envelope';
import { useChartColors } from './chartColors';
import { formatSigned, MILLIMETER_DIGITS } from './format';
import { collectStations, findInlineEvidence, formatDateRange, type StationEvidence } from './investigation';
import { InlineEvidenceResult } from './InvestigationProcess';
import { useStationInspector, type InspectorViewState } from './StationInspectorContext';
import {
  buildTimelineOption,
  dailyRainfallWithin,
  displacementBasis,
  displacementBasisLabel,
  displacementOf,
  referenceOf,
  formatChartTime,
  peerSeriesFor,
  seriesDuration,
  seriesLabel,
  type TimelineMode,
} from './timeline';
import type { ChartRange, ChartSelection } from './TimelineChart';
import { GnssResultView } from './tools/GnssResultView';
import { NumericalResultView } from './tools/NumericalResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { StationStatus } from './tools/StationResultView';
import { timelineAskTarget } from './ask-targets';
import { WeatherEvidence } from './WeatherEvidence';

const TimelineChart = lazy(() => import('./TimelineChart'));

const MILLIMETERS_PER_METER = 1000;

const formatMillimeters = (millimeters: number | null | undefined) =>
  millimeters === null || millimeters === undefined ? '—' : formatSigned(millimeters, MILLIMETER_DIGITS);

const METRIC_AXES = [
  { axis: 'n', label: '北向' },
  { axis: 'e', label: '东向' },
  { axis: 'u', label: '垂直' },
] as const;

export const WindowMetrics: FC<{ data: GnssArtifactData }> = ({ data }) => {
  const reference = referenceOf(data);
  const displacement = displacementOf(data);
  const basis = displacementBasis(data);
  const latestOf = (axis: 'n' | 'e' | 'u') => {
    for (let index = displacement.length - 1; index >= 0; index -= 1) {
      const value = displacement[index]![axis];
      if (value !== null) return value;
    }
    return null;
  };
  const windowChange = (axis: 'n' | 'e' | 'u') => {
    const meters = data.summary[axis].change;
    return meters === null || meters === undefined ? null : meters * MILLIMETERS_PER_METER;
  };
  return (
    <div>
      {basis !== 'partial' && (
        <p className="mb-2 text-sm text-muted-foreground">{basis === 'fixed' ? '累计位移' : '本窗口净变化'}</p>
      )}
      <dl className="grid grid-cols-3 gap-x-3 gap-y-3 sm:grid-cols-4">
        {METRIC_AXES.map(({ axis, label }) => {
          const hasReference = reference[axis] !== null;
          return (
            <div key={axis} className="min-w-0">
              <dt className="text-sm text-muted-foreground">
                {label}
                {basis === 'partial' && <span className="block text-xs">{hasReference ? '累计' : '本窗口变化'}</span>}
              </dt>
              <dd className="mt-0.5 text-xl font-medium tabular-nums">
                {formatMillimeters(hasReference ? latestOf(axis) : windowChange(axis))}
                <span className="ms-1 text-sm font-normal text-muted-foreground">mm</span>
              </dd>
              {hasReference && (
                <dd className="text-xs text-muted-foreground tabular-nums">本窗口 {formatMillimeters(windowChange(axis))} mm</dd>
              )}
            </div>
          );
        })}
        {data.summary.gaps.length > 0 && (
          <div className="min-w-0">
            <dt className="text-sm text-muted-foreground">缺测</dt>
            <dd className="mt-0.5 text-xl font-medium tabular-nums text-status-attention">
              {data.summary.gaps.length}<span className="ms-1 text-sm font-normal text-muted-foreground">段</span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
};

interface TimelineViewProps {
  station: StationEvidence;
  seriesList: readonly GnssArtifactData[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  peers: readonly StationEvidence[];
  viewState: InspectorViewState;
  toolCallId: string;
}

const uniqueSeriesOptions = (seriesList: readonly GnssArtifactData[]) => {
  const counts = new Map<string, number>();
  for (const item of seriesList) {
    const label = seriesLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return seriesList.map((item, index) => {
    const base = seriesLabel(item);
    const total = counts.get(base) ?? 1;
    if (total === 1) {
      return { value: String(index), label: base };
    }
    const order = (seen.get(base) ?? 0) + 1;
    seen.set(base, order);
    return { value: String(index), label: `${base} (${order})` };
  });
};

const TimelineView: FC<TimelineViewProps> = ({ station, seriesList, selectedIndex, onSelectIndex, peers, viewState, toolCallId }) => {
  const { attachAskTarget, isSplit, composerInputRef, closeInspector } = useStationInspector();
  const isThreadRunning = useAuiState((state) => state.thread.isRunning);
  const chartColors = useChartColors();
  const [mode, setMode] = useState<TimelineMode>(viewState.mode ?? 'components');
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const data = seriesList[selectedIndex]!;
  const seriesOptions = useMemo(() => uniqueSeriesOptions(seriesList), [seriesList]);
  const peerSeries = useMemo(
    () => peerSeriesFor(data, peers.map((peer) => ({ name: peer.name, series: peer.series.map((item) => item.data) }))),
    [data, peers],
  );
  const rainfall = useMemo(() => dailyRainfallWithin(station.weather.map((item) => item.data), data.begin_time, data.end_time), [station.weather, data]);
  const option = useMemo(() => buildTimelineOption(
      { data, rainfall, peers: peerSeries, mode: peerSeries.length > 0 ? mode : 'components' },
      chartColors,
  ), [rainfall, data, peerSeries, mode, chartColors]);

  const askAbout = (target: ChartRange | ChartSelection) => {
    const source = station.series.find((item) => item.toolCallId === toolCallId)!;
    attachAskTarget(timelineAskTarget(target, source, station.weather));
    if (isSplit) {
      composerInputRef.current?.focus();
    } else {
      closeInspector({ focusComposer: true });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {seriesList.length > 1 ? (
          <div className="max-w-full overflow-x-auto">
            <Segmented
              label="时间窗口"
              value={String(selectedIndex)}
              options={seriesOptions}
              onValueChange={(value) => onSelectIndex(Number(value))}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{seriesLabel(data)}</p>
        )}
        {peerSeries.length > 0 && (
          <Segmented
            label="曲线内容"
            value={mode}
            options={[
              { value: 'components', label: '三个方向' },
              { value: 'peers', label: '同组对比' },
            ]}
            onValueChange={(value) => {
              viewState.mode = value as TimelineMode;
              setMode(value as TimelineMode);
            }}
          />
        )}
      </div>

      <WindowMetrics data={data} />

      <div>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm text-muted-foreground tabular-nums">
            {range && `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}`}
            {!range && displacementBasis(data) !== 'fixed' && displacementBasisLabel(data)}
          </p>
          {range && (
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setResetSignal((value) => value + 1)}>
                还原
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={isThreadRunning} onClick={() => askAbout(range)}>
                {range.kind === 'rainfall' ? '问当前降雨' : '问当前范围'}
              </Button>
            </div>
          )}
        </div>
        <ErrorBoundary fallbackTitle="时间轴渲染异常">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <TimelineChart
              viewKey={`${station.id}:${toolCallId}:${mode}`}
              option={option}
              label={`${station.name} ${seriesLabel(data)} 位移时间轴`}
              resetSignal={resetSignal}
              onRangeChange={setRange}
              onAsk={askAbout}
              askDisabled={isThreadRunning}
              hasRainfall={rainfall.length > 0}
              initialState={viewState.charts.get(`${toolCallId}:${mode}`)}
              onStateChange={(state) => viewState.charts.set(`${toolCallId}:${mode}`, state)}
            />
          </Suspense>
        </ErrorBoundary>
      </div>

    </div>
  );
};

const DetailSection: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="space-y-3">
    <h3 className="text-sm font-medium">{title}</h3>
    {children}
  </section>
);

const EvidenceNotes: FC<{ station: StationEvidence; toolCallId?: string }> = ({ station, toolCallId }) => {
  const envelopes = [...station.series, ...station.weather, ...station.site]
    .filter((item) => !toolCallId || item.toolCallId === toolCallId);
  const limitations = [...new Set(envelopes.flatMap((envelope) => envelope.limitations ?? []))];
  const sourcesByLabel = new Map<string, EvidenceSource>();
  for (const source of envelopes.flatMap((envelope) => envelope.sources ?? [])) {
    const sourceLabel = source.name || source.provider;
    if (sourceLabel) {
      sourcesByLabel.set(sourceLabel, source);
    }
  }
  if (limitations.length === 0 && sourcesByLabel.size === 0) return null;

  return (
    <footer className="mt-8 space-y-3 border-t pt-4 text-sm text-muted-foreground">
      {limitations.length > 0 && (
        <ul aria-label="数据限制" className="space-y-1.5">
          {limitations.map((limitation) => <li key={limitation} className="wrap-break-word">{limitation}</li>)}
        </ul>
      )}
      {sourcesByLabel.size > 0 && (
        <ul aria-label="来源" className="flex flex-wrap gap-x-4 gap-y-1">
          {[...sourcesByLabel].map(([sourceLabel, source]) => (
            <li key={sourceLabel}>
              {source.url && /^https?:\/\//i.test(source.url)
                ? <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{sourceLabel}</a>
                : sourceLabel}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
};

const initialTab = (station: StationEvidence, focusToolCallId: string | undefined): string => {
  const isFocused = (items: readonly { toolCallId: string }[]) => items.some((item) => item.toolCallId === focusToolCallId);
  if (isFocused(station.site)) {
    return 'site';
  }
  if (isFocused(station.weather)) {
    return 'weather';
  }
  if (station.series.length > 0) {
    return 'timeline';
  }
  if (station.site.length > 0) {
    return 'site';
  }
  if (station.weather.length > 0) {
    return 'weather';
  }
  return 'details';
};

const TAB_CLASS = 'h-11 flex-none px-1 font-normal text-muted-foreground group-data-[orientation=horizontal]/tabs:after:-bottom-px';

interface InspectorBodyProps {
  viewKey: string;
  selectionVersion: number;
  station: StationEvidence;
  focusToolCallId?: string;
  stations: readonly StationEvidence[];
  title: ReactNode;
  onSelectStation: (stationId: string) => void;
  onClose: () => void;
}

const InspectorBody: FC<InspectorBodyProps> = ({
  viewKey,
  selectionVersion,
  station,
  focusToolCallId,
  stations,
  title,
  onSelectStation,
  onClose,
}) => {
  const { viewStates, canExpand, isFullscreen, toggleFullscreen } = useStationInspector();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const saved = useMemo(() => {
    let state = viewStates.current.get(viewKey);
    if (!state) {
      state = { charts: new Map() };
      viewStates.current.set(viewKey, state);
    }
    return state;
  }, [viewKey, viewStates]);
  const sortedSeries = useMemo(
    () => [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data)),
    [station.series],
  );
  const seriesList = useMemo(() => sortedSeries.map((item) => item.data), [sortedSeries]);
  const [selectedIndex, updateSelectedIndex] = useState(
    () => Math.max(0, sortedSeries.findIndex((item) => item.toolCallId === (saved.selectedToolCallId ?? focusToolCallId))),
  );
  const setSelectedIndex = (index: number) => {
    saved.selectedToolCallId = sortedSeries[index]?.toolCallId;
    updateSelectedIndex(index);
  };

  const peers = useMemo(
    () => stations.filter((candidate) => (
      candidate.id !== station.id
      && candidate.series.length > 0
      && Boolean(station.group)
      && candidate.group === station.group
    )),
    [stations, station],
  );

  const stationIndex = stations.findIndex((item) => item.id === station.id);
  const previousStation = stations[stationIndex - 1];
  const nextStation = stations[stationIndex + 1];
  const hasTimeline = seriesList.length > 0;
  const hasSite = station.site.length > 0;
  const hasWeather = station.weather.length > 0;
  const [activeTab, updateActiveTab] = useState(saved.tab ?? initialTab(station, focusToolCallId));
  const setActiveTab = (tab: string) => {
    saved.tab = tab;
    updateActiveTab(tab);
    scrollContainerRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (!focusToolCallId) return;
    const targetTab = saved.tab ?? initialTab(station, focusToolCallId);
    updateActiveTab(targetTab);
    const matchingIndex = sortedSeries.findIndex((item) => item.toolCallId === focusToolCallId);
    if (matchingIndex >= 0) {
      updateSelectedIndex(matchingIndex);
    }
  }, [selectionVersion, focusToolCallId, station, sortedSeries, saved]);

  const siteEvidence = station.site.find((item) => item.toolCallId === focusToolCallId) ?? station.site.at(-1);
  let noteToolCallId = focusToolCallId;
  if (activeTab === 'timeline') {
    noteToolCallId = sortedSeries[selectedIndex]?.toolCallId;
  } else if (activeTab === 'site') {
    noteToolCallId = siteEvidence?.toolCallId;
  } else if (activeTab === 'weather' && station.weather.length === 1) {
    noteToolCallId = station.weather[0]!.toolCallId;
  }
  const weatherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeTab !== 'weather' || !focusToolCallId) {
      return;
    }
    const target = weatherRef.current?.querySelector<HTMLElement>(`[data-evidence-tool="${CSS.escape(focusToolCallId)}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  }, [activeTab, focusToolCallId, selectionVersion]);

  const showDeviceStatus = Boolean(station.status && station.status !== '正常');

  return (
    <>
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          {title}
          {showDeviceStatus && <StationStatus status={station.status} />}
        </div>
        <div className="flex shrink-0 items-center">
          {stations.length > 1 && (
            <div className="me-1 flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9"
                disabled={!previousStation}
                title={previousStation ? `上一个：${previousStation.name}` : '已是第一个测点'}
                aria-label="上一个测点"
                onClick={() => onSelectStation(previousStation!.id)}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="px-1 text-xs text-muted-foreground tabular-nums">
                {stationIndex + 1}/{stations.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9"
                disabled={!nextStation}
                title={nextStation ? `下一个：${nextStation.name}` : '已是最后一个测点'}
                aria-label="下一个测点"
                onClick={() => onSelectStation(nextStation!.id)}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          )}
          {canExpand && <Button type="button" variant="ghost" size="icon" className="size-9" title={isFullscreen ? '恢复分栏' : '展开全屏'} aria-label={isFullscreen ? '恢复依据分栏' : '展开依据全屏'} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
          </Button>}
          <Button type="button" variant="ghost" size="icon" className="size-9" title="关闭" aria-label="关闭依据" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" aria-label="依据内容" className="w-full shrink-0 justify-start gap-5 rounded-none border-b p-0 px-4 group-data-[orientation=horizontal]/tabs:h-auto sm:px-6">
          {hasTimeline && <TabsTrigger value="timeline" className={TAB_CLASS}>时间轴</TabsTrigger>}
          {hasWeather && <TabsTrigger value="weather" className={TAB_CLASS}>天气</TabsTrigger>}
          {hasSite && <TabsTrigger value="site" className={TAB_CLASS}>场地</TabsTrigger>}
          <TabsTrigger value="details" className={TAB_CLASS}>明细</TabsTrigger>
        </TabsList>

        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6">
          {hasTimeline && (
            <TabsContent value="timeline" forceMount hidden={activeTab !== 'timeline'}>
              <TimelineView
                station={station}
                seriesList={seriesList}
                selectedIndex={selectedIndex}
                onSelectIndex={setSelectedIndex}
                peers={peers}
                viewState={saved}
                toolCallId={sortedSeries[selectedIndex]!.toolCallId}
              />
            </TabsContent>
          )}
          {hasSite && (
            <TabsContent value="site">
              <SiteEnvironmentResultView environment={siteEvidence!.data} />
            </TabsContent>
          )}
          {hasWeather && (
            <TabsContent ref={weatherRef} value="weather" className="space-y-8">
              {station.weather.map((item) => (
                <div key={item.toolCallId} data-evidence-tool={item.toolCallId}>
                  <DetailSection title={formatDateRange(item.data.query.history_start_date, item.data.query.history_end_date)}>
                    <WeatherEvidence evidence={item} inInspector />
                  </DetailSection>
                </div>
              ))}
            </TabsContent>
          )}
          <TabsContent value="details" className="space-y-8">
            {sortedSeries.filter((item) => Object.keys(item.data.features ?? {}).length > 0).map((item) => (
              <DetailSection key={item.toolCallId} title={`数值特征 · ${seriesLabel(item.data)}`}>
                <NumericalResultView data={item.data} />
              </DetailSection>
            ))}
            {hasTimeline && (
              <Collapsible className="rounded-lg border">
                <CollapsibleTrigger className="group/raw flex min-h-10 w-full items-center gap-2 px-3 text-start text-sm font-medium transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/raw:rotate-90" aria-hidden />
                  <span>原始坐标 · {seriesLabel(seriesList[selectedIndex]!)}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t p-3">
                  <GnssResultView data={seriesList[selectedIndex]!} />
                </CollapsibleContent>
              </Collapsible>
            )}
          </TabsContent>
          <EvidenceNotes station={station} toolCallId={noteToolCallId} />
        </div>
      </Tabs>
    </>
  );
};

interface EvidenceBodyProps {
  envelope: ToolArtifactEnvelope;
  title: ReactNode;
  onClose: () => void;
}

const EvidenceBody: FC<EvidenceBodyProps> = ({ envelope, title, onClose }) => {
  const { canExpand, isFullscreen, toggleFullscreen } = useStationInspector();
  return (
    <>
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
        {title}
        <div className="flex shrink-0 items-center">
          {canExpand && <Button type="button" variant="ghost" size="icon" className="size-10" aria-label={isFullscreen ? '恢复依据分栏' : '展开依据全屏'} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
          </Button>}
          <Button type="button" variant="ghost" size="icon" className="size-10" aria-label="关闭依据" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6">
        <InlineEvidenceResult envelope={envelope} />
      </div>
    </>
  );
};

export const StationInspector: FC = () => {
  const { selection, selectionVersion, isClosing, isSplit, openStation, closeInspector, finishClose } = useStationInspector();
  const setFocusStation = useOptionalSetFocusStation();
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const resize = usePanelResize({
    storageKey: 'lma-inspector-width',
    defaultWidth: Math.min(896, window.innerWidth * 0.56),
    minWidth: 420,
    maxWidth: 1000,
    side: 'right',
    panelRef,
    availableWidth: () => {
      const navigationWidth = document.querySelector('[data-navigation-docked]')?.getBoundingClientRect().width ?? 0;
      return window.innerWidth - navigationWidth - 360;
    },
  });
  const messageContent = useAuiState((state) => (
    selection ? state.thread.messages.find((message) => message.id === selection.messageId)?.content : undefined
  ));
  const stations = useMemo(() => (messageContent ? collectStations(messageContent) : []), [messageContent]);
  const station = selection?.stationId ? stations.find((item) => item.id === selection.stationId) : undefined;
  const evidence = useMemo(() => {
    if (!messageContent || !selection?.toolCallId || selection.stationId) {
      return undefined;
    }
    return findInlineEvidence(messageContent, selection.toolCallId);
  }, [messageContent, selection]);
  const hasContent = station !== undefined || evidence !== undefined;

  useEffect(() => {
    if (!setFocusStation) return;
    setFocusStation(hasContent && station ? station.name : null);
    return () => setFocusStation(null);
  }, [hasContent, station, setFocusStation]);

  const hasLostSelection = selection !== null && !hasContent;
  useEffect(() => {
    if (hasLostSelection) {
      closeInspector();
    }
  }, [hasLostSelection, closeInspector]);

  const isInspectorOpen = hasContent && !isClosing;
  useEffect(() => {
    if (!isInspectorOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        resize.onEscapeKeyDown(event);
        if (!event.defaultPrevented) {
          closeInspector();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isInspectorOpen, closeInspector, resize]);

  useEffect(() => {
    if (hasContent && !isSplit && !isClosing) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [hasContent, isSplit, isClosing]);

  if (!selection || !hasContent) {
    return null;
  }

  const titleText = station ? station.name : evidence!.title;
  const close = () => closeInspector();
  const viewKey = station ? `${selection.messageId}:${station.id}` : `${selection.messageId}:${selection.toolCallId}`;
  const title = <h2 id={titleId} className="min-w-0 truncate text-base font-medium">{titleText}</h2>;

  return (
    <aside
      id={isSplit ? 'station-evidence' : undefined}
      ref={panelRef}
      tabIndex={!isSplit ? -1 : undefined}
      role={!isSplit ? 'dialog' : undefined}
      aria-modal={!isSplit ? true : undefined}
      aria-labelledby={!isSplit ? titleId : undefined}
      aria-label={isSplit ? `${titleText} 依据` : undefined}
      data-station-inspector=""
      data-state={isClosing ? 'closed' : 'open'}
      inert={isClosing}
      onTransitionEnd={(event) => {
        if (isClosing && isSplit && event.target === event.currentTarget && event.propertyName === 'width') {
          finishClose();
        }
      }}
      onAnimationEnd={(event) => {
        if (isClosing && !isSplit && event.target === event.currentTarget) {
          finishClose();
        }
      }}
      style={isSplit ? resize.style : undefined}
      className={
        isSplit
          ? 'inspector-panel relative flex h-full min-w-0 flex-col border-l bg-background pt-[env(safe-area-inset-top)]'
          : 'inspector-overlay fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] outline-none'
      }
    >
      {isSplit && <PanelResizeHandle label="调整聊天与依据宽度" panelId="station-evidence" edge="left" {...resize.handleProps} />}
      {!station ? (
        <EvidenceBody key={viewKey} envelope={evidence!.envelope} title={title} onClose={close} />
      ) : (
        <InspectorBody
          key={viewKey}
          viewKey={viewKey}
          selectionVersion={selectionVersion}
          station={station}
          focusToolCallId={selection.toolCallId}
          stations={stations}
          title={title}
          onSelectStation={(stationId) => openStation({ messageId: selection.messageId, stationId })}
          onClose={close}
        />
      )}
    </aside>
  );
};
