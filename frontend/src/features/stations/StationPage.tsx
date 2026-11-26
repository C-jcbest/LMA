import { lazy, Suspense, useMemo, useRef, useState, type FC } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, Maximize2, Minimize2, PlusIcon, XIcon } from 'lucide-react';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import { useNavigation } from '@/app/navigation';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useConversationLoading } from '@/app/providers/AssistantProvider';
import { StationConversation } from './StationConversation';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { FindingChips, findingLabel, triggersOf } from '@/features/inspection/findings';
import { useInspection } from '@/features/inspection/InspectionContext';
import { useChartColors } from '@/features/monitoring/chartColors';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { WindowMetrics } from '@/features/monitoring/StationInspector';
import { chartClock, chartDay, chartMillis } from '@/features/monitoring/chart-time';
import { useStationInspector } from '@/features/monitoring/StationInspectorContext';
import { StatusDot } from '@/features/monitoring/status';
import { buildTimelineOption, displacementBasis, displacementBasisLabel, formatChartTime, peerSeriesFor, type DailyRainfall, type PeerSeries } from '@/features/monitoring/timeline';
import { RainEvents } from '@/features/monitoring/RainEvents';
import type { ChartRange, ChartSelection } from '@/features/monitoring/TimelineChart';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from 'cn';
import type { InspectionStation, ScreeningFinding, StationRecord, StationWindow, TimelineDays } from '@/services/api';
import type { GnssArtifactData, RainEvent } from '@/types/envelope';

const TimelineChart = lazy(() => import('@/features/monitoring/TimelineChart'));

const seriesDateRange = (data: GnssArtifactData) => {
  const start = chartClock(chartMillis(data.begin_time)).slice(0, 10);
  const end = chartClock(chartMillis(data.end_time)).slice(0, 10);
  return start === end ? start : start + ' 至 ' + end;
};

const WINDOW_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];

const DAY_MILLIS = 86400e3;
const MAX_RANGE_DAYS = 366;
const toDateInput = (value: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(value);

function customRangeDays(begin: string, end: string) {
  return (Date.parse(end) - Date.parse(begin)) / DAY_MILLIS + 1;
}

function storedWindow(stationUuid: string): StationWindow {
  try {
    const saved = JSON.parse(sessionStorage.getItem('lma-station-window:' + stationUuid) ?? 'null');
    if (saved && [7, 30, 90].includes(saved.days)) return { days: saved.days };
    if (typeof saved?.begin === 'string' && typeof saved.end === 'string') {
      const span = customRangeDays(saved.begin, saved.end);
      if (span >= 1 && span <= MAX_RANGE_DAYS && saved.end <= toDateInput(new Date())) {
        return { begin: saved.begin, end: saved.end };
      }
    }
  } catch {
  }
  return { days: 90 };
}

const CustomRangeForm: FC<{
  initial?: { begin: string; end: string };
  onApply: (range: { begin: string; end: string }) => void;
  onCancel: () => void;
}> = ({ initial, onApply, onCancel }) => {
  const today = toDateInput(new Date());
  const [begin, setBegin] = useState(initial?.begin ?? toDateInput(new Date(Date.now() - 30 * DAY_MILLIS)));
  const [end, setEnd] = useState(initial?.end ?? today);
  const span = customRangeDays(begin, end);
  let errorMessage: string | null = null;
  if (!begin || !end) {
    errorMessage = '请选择开始和结束日期';
  } else if (span < 1) {
    errorMessage = '结束日期不能早于开始日期';
  } else if (end > today) {
    errorMessage = '结束日期不能晚于今天';
  } else if (span > MAX_RANGE_DAYS) {
    errorMessage = '最多 366 天（含起止日）';
  }
  const isValid = errorMessage === null;
  return (
    <form
      className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (isValid) {
          onApply({ begin, end });
        }
      }}
    >
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:w-auto">
        <Input type="date" aria-label="开始日期" value={begin} max={end || today} onChange={(event) => setBegin(event.target.value)} className="min-w-0 px-2" />
        <span aria-hidden className="text-muted-foreground">至</span>
        <Input type="date" aria-label="结束日期" value={end} min={begin} max={today} onChange={(event) => setEnd(event.target.value)} className="min-w-0 px-2" />
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={!isValid}>查看</Button>
      </div>
      {errorMessage && <p role="alert" className="w-full text-xs text-muted-foreground">{errorMessage}</p>}
    </form>
  );
};

type Panel = 'data' | 'chat';

function StationInvestigationTitle() {
  const title = useAuiState((state) => {
    const current = state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId);
    return current?.title || '新调查';
  });
  return <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</span>;
}

function NewStationInvestigationButton({ onStarted }: { onStarted: () => void }) {
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed && <span role="alert" className="text-xs">请重试</span>}
      <Button variant="ghost" size="icon" title="新调查" aria-label="开始新的测点调查" disabled={running} onClick={async () => {
        setFailed(false);
        try {
          await aui.threads().switchToNewThread();
          onStarted();
        } catch {
          setFailed(true);
        }
      }}><PlusIcon className="size-4" /></Button>
    </>
  );
}

function StationChatActions({ stationName, expanded, onBack, onExpand, onClose, onNewInvestigation }: {
  stationName: string;
  expanded: boolean;
  onBack: () => void;
  onExpand: () => void;
  onClose: () => void;
  onNewInvestigation: () => void;
}) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-1 border-b px-3">
      {expanded && (
        <>
          <Button type="button" variant="ghost" size="icon" className="-ms-1 size-8 text-muted-foreground" aria-label="返回" onClick={onBack}>
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="shrink-0 text-sm font-semibold">{stationName}</span>
          <span aria-hidden className="px-0.5 text-muted-foreground">/</span>
        </>
      )}
      <StationInvestigationTitle />
      <NewStationInvestigationButton onStarted={onNewInvestigation} />
      <Button variant="ghost" size="icon" title={expanded ? '恢复分栏' : '展开调查'} aria-label={expanded ? '恢复分栏' : '展开调查'} onClick={onExpand}>
        {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </Button>
      <Button variant="ghost" size="icon" title="关闭调查面板" aria-label="关闭调查面板" onClick={onClose}><XIcon className="size-4" /></Button>
    </div>
  );
}

function StationRecords({ records, anchorId, onOpened }: { records: readonly StationRecord[]; anchorId?: string; onOpened: (anchorId: string) => void }) {
  const aui = useAui();
  const sessionId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  return (
    <RecordList records={records} selected={{ sessionId, anchorId }} onOpen={async (record) => {
      await aui.threads().switchToThread(record.session_id);
      onOpened(record.anchor_id);
    }} />
  );
}

const formatRecordDate = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(value));
};

const DisplacementChart: FC<{
  stationName: string;
  data: GnssArtifactData;
  rainfall: readonly DailyRainfall[];
  rainEvents?: readonly RainEvent[];
  rainfallDaily?: ReadonlyArray<{ date: string; value: number | null }>;
  rainThresholdMm?: number;
  peers: readonly PeerSeries[];
  findings: readonly ScreeningFinding[];
  onAsk: () => void;
  disabled: boolean;
}> = ({ stationName, data, rainfall, rainEvents, rainfallDaily, rainThresholdMm, peers, findings, onAsk, disabled }) => {
  const { attachAskTarget, composerInputRef } = useStationInspector();
  const isLoading = useConversationLoading();
  const chartColors = useChartColors();
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const mode = peers.length > 0 ? 'peers' : 'components';
  const option = useMemo(
    () => buildTimelineOption({ data, rainfall, peers, mode, findings }, chartColors),
    [data, rainfall, peers, mode, findings, chartColors],
  );

  const askAbout = (target: ChartRange | ChartSelection) => {
    attachAskTarget({ kind: target.kind ?? 'displacement', stationUuid: data.station_uuid, stationName, start: target.start, end: target.end });
    onAsk();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const askAboutRainEvent = (event: RainEvent) => {
    const start = chartDay(chartMillis(event.start)).start;
    const end = chartDay(chartMillis(event.end)).end;
    askAbout({ kind: 'rainfall', start, end });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-muted-foreground min-w-0 text-sm tabular-nums">
            {range && `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}`}
            {!range && displacementBasis(data) !== 'fixed' && displacementBasisLabel(data)}
          </p>
          {range && (
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setResetSignal((value) => value + 1)}>还原</Button>
              <Button type="button" variant="outline" size="sm" disabled={isLoading || disabled} onClick={() => askAbout(range)}>{range.kind === 'rainfall' ? '问当前降雨' : '问当前范围'}</Button>
            </div>
          )}
        </div>
        <ErrorBoundary fallbackTitle="时间轴渲染异常">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <TimelineChart
              viewKey={`${data.station_uuid}:${data.begin_time}:${data.end_time}:${mode}`}
              option={option}
              label={`${stationName} 位移时间轴`}
              resetSignal={resetSignal}
              onRangeChange={setRange}
              onAsk={askAbout}
              hasRainfall={rainfall.length > 0}
              askDisabled={isLoading || disabled}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
      {rainEvents && rainfallDaily && (
        <RainEvents
          events={rainEvents}
          daily={rainfallDaily}
          thresholdMm={rainThresholdMm ?? 25}
          onAskEvent={askAboutRainEvent}
          askDisabled={isLoading || disabled}
        />
      )}
    </div>
  );
};

const RecordList: FC<{ records: readonly StationRecord[]; selected: { sessionId?: string; anchorId?: string }; onOpen: (record: StationRecord) => Promise<void> }> = ({ records, selected, onOpen }) => {
  const [opening, setOpening] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  if (records.length === 0) {
    return <p className="text-muted-foreground text-sm">暂无关联的调查记录。</p>;
  }
  return (
    <div>
    {hasError && <p role="alert" className="text-sm text-muted-foreground">这次调查尚未打开，请重试。</p>}
    <ul className="-mx-3">
      {records.map((record) => {
        let statusLabel = '调查';
        if (record.status) {
          statusLabel = investigationStatusLabel(record.status);
        } else if (record.validated === false) {
          statusLabel = '历史结果待复核';
        }
        return (
        <li key={`${record.session_id}:${record.anchor_id}`}>
          <button
            type="button"
            disabled={opening !== null}
            aria-current={record.session_id === selected.sessionId && record.anchor_id === selected.anchorId ? 'true' : undefined}
            onClick={async () => {
              setOpening(record.anchor_id);
              setHasError(false);
              try {
                await onOpen(record);
              } catch {
                setHasError(true);
              } finally {
                setOpening(null);
              }
            }}
            className="record-row w-full rounded-lg text-start text-sm transition hover:bg-muted/60 active:scale-99 disabled:opacity-50 aria-[current=true]:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="text-muted-foreground tabular-nums">{formatRecordDate(record.created_at)}</span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <StatusDot status={record.status} />{statusLabel}
            </span>
            <span className="text-muted-foreground min-w-0 truncate">{record.reason}</span>
          </button>
        </li>
        );
      })}
    </ul>
    </div>
  );
};

const StationAsk: FC<{ stationName: string; inspection: InspectionStation | undefined }> = ({ stationName, inspection }) => {
  const aui = useAui();
  const isLoading = useConversationLoading();
  const needsLook = inspection?.screening === '建议调查';
  const leads = inspection ? triggersOf(inspection.findings).map(findingLabel) : [];
  const question = leads.length > 0
    ? `调查 ${stationName} 的近期变化，巡检线索：${leads.join('、')}`
    : `调查 ${stationName} 的近期变化`;

  return (
    <div className="aui-thread-welcome-root flex flex-col gap-3 py-5">
      {needsLook && (
        <Button
          type="button"
          disabled={isLoading}
          className="self-start rounded-full"
          onClick={() => aui.thread().append({ role: 'user', content: [{ type: 'text', text: question }] })}
        >
          调查 {stationName}
        </Button>
      )}
    </div>
  );
};

export const StationPage: FC<{ stationUuid: string; active: boolean; onRunningChange: (running: boolean) => void }> = ({ stationUuid, active, onRunningChange }) => {
  const client = useLmaClient();
  const globalAui = useAui();
  const { returnFromStation, resultAnchor: recordAnchor, showStationResult: setRecordAnchor } = useNavigation();
  const { latest, reload: reloadInspection } = useInspection();
  const isSideBySide = useMediaQuery('(min-width: 1100px)');
  const queryClient = useQueryClient();
  const [timeWindow, updateTimeWindow] = useState<StationWindow>(() => storedWindow(stationUuid));
  const setTimeWindow = (next: StationWindow) => {
    updateTimeWindow(next);
    try {
      sessionStorage.setItem('lma-station-window:' + stationUuid, JSON.stringify(next));
    } catch {
    }
  };
  const [isEditingRange, setIsEditingRange] = useState(false);
  const [showPeers, setShowPeers] = useState(false);
  const timelineQuery = useQuery({
    queryKey: ['station-timeline', stationUuid, timeWindow],
    queryFn: ({ signal }) => client.getStationTimeline(stationUuid, timeWindow, signal),
    placeholderData: keepPreviousData,
  });
  const timeline = timelineQuery.data ?? null;
  const rainfallQuery = useQuery({
    queryKey: ['station-rainfall', stationUuid, timeWindow],
    queryFn: ({ signal }) => client.getStationRainfall(stationUuid, timeWindow, signal),
    placeholderData: keepPreviousData,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  const rainfall = rainfallQuery.data;
  const dailyRainfall = useMemo<DailyRainfall[]>(
    () => (rainfall?.daily ?? []).flatMap((day) => (day.value === null ? [] : [{ date: day.date, value: day.value, isForecast: false }])),
    [rainfall],
  );
  const isSwitchingWindow = timelineQuery.isPlaceholderData;
  const hasError = timelineQuery.isError;
  const [panel, setPanel] = useState<Panel>(() => new URL(window.location.href).searchParams.has('stationThread') ? 'chat' : 'data');
  const [chatMode, setChatMode] = useState<'split' | 'closed' | 'expanded'>('split');
  const chatRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const chatResize = usePanelResize({
    storageKey: 'lma-station-chat-width', defaultWidth: 416, minWidth: 320, maxWidth: 1000,
    side: 'right', panelRef: chatRef,
    availableWidth: () => (layoutRef.current?.clientWidth ?? window.innerWidth) - 360,
  });
  const investigationCompleted = () => {
    void queryClient.invalidateQueries({ queryKey: ['station-timeline', stationUuid] });
    void queryClient.invalidateQueries({ queryKey: ['session-conclusions'] });
    void globalAui.threads().reload();
    reloadInspection();
  };

  const directoryQuery = useQuery({ queryKey: ['stations'], queryFn: ({ signal }) => client.listStations(signal) });
  const self = directoryQuery.data?.find((station) => station.station_uuid === stationUuid);
  const groupPeers = (directoryQuery.data ?? []).filter((station) => (
    self !== undefined && station.group_name === self.group_name && station.station_uuid !== stationUuid
    && Boolean(station.station_type?.startsWith('移动站'))
  ));
  const peerQueries = useQueries({
    queries: groupPeers.map((peer) => ({
      queryKey: ['station-timeline', peer.station_uuid, timeWindow],
      queryFn: ({ signal }: { signal: AbortSignal }) => client.getStationTimeline(peer.station_uuid, timeWindow, signal),
      enabled: showPeers,
      staleTime: 5 * 60 * 1000,
    })),
  });
  const peerDataKey = peerQueries.map((query) => query.dataUpdatedAt).join();
  const peerSeries = useMemo(() => {
    const data = timelineQuery.data?.series;
    if (!showPeers || !data) {
      return [];
    }
    const loaded = peerQueries.flatMap((query) => (
      query.data?.series ? [{ name: query.data.station_name, series: [query.data.series] }] : []
    ));
    return peerSeriesFor(data, loaded);
  }, [showPeers, timelineQuery.data, peerDataKey]);

  const inspection = latest?.stations.find((station) => station.station_uuid === stationUuid);
  const dateOf = (time: string) => chartClock(chartMillis(time)).slice(0, 10);
  const series = timeline?.series;
  const lastObservation = series?.points.filter((point) => point.n !== null || point.e !== null || point.u !== null).at(-1)?.time;
  const inspectedObservation = inspection?.metrics.last_observed_at;
  const inspectedDate = inspectedObservation ? dateOf(inspectedObservation) : null;
  const viewedCurrentWindow = 'days' in timeWindow;
  const findings = useMemo(() => {
    if (!inspection || !series || isSwitchingWindow) return [];
    const start = chartMillis(series.begin_time);
    const end = chartMillis(series.end_time);
    return triggersOf(inspection.findings).filter((finding) => {
      if (finding.time) {
        const time = chartMillis(finding.time);
        return time >= start && time <= end;
      }
      return 'days' in timeWindow && timeWindow.days === 90 && finding.window === 'long';
    });
  }, [inspection, series, isSwitchingWindow, timeWindow]);
  const stationName = timeline?.station_name ?? inspection?.station_name;
  const groupName = timeline?.group_name ?? inspection?.group_name;

  const showChat = () => {
    setPanel('chat');
    setChatMode('split');
  };

  const hasDisplacementSeries = !timeline || timeline.series !== null;
  const dataPanel = (conversationReady: boolean) => (
    <section aria-label="测点数据" className="h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="station-data">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {(isSideBySide || !stationName) && <Button type="button" variant="ghost" size="icon" className="-ms-2 size-9 text-muted-foreground" aria-label="返回" onClick={returnFromStation}>
            <ArrowLeftIcon className="size-4" />
          </Button>}
          {(isSideBySide || !stationName) && <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere">{stationName ?? '测点'}</h1>}
          {groupName && <span className="text-muted-foreground text-sm">{groupName}</span>}
          {viewedCurrentWindow && inspection && (
            <span className="bg-muted inline-flex min-h-7 items-center gap-2 rounded-full px-3 text-xs">
              <StatusDot status={inspection.screening} />{investigationStatusLabel(inspection.screening)}
            </span>
          )}
          {hasDisplacementSeries && (
            <div className={cn('flex flex-wrap items-center gap-2', isSideBySide && 'ms-auto')}>
              {groupPeers.length > 0 && (
                <Toggle size="sm" variant="outline" pressed={showPeers} onPressedChange={setShowPeers}>同组对比</Toggle>
              )}
              <div className="flex items-center gap-1">
                <Segmented
                  label="时间范围"
                  value={'days' in timeWindow && !isEditingRange ? String(timeWindow.days) : ''}
                  options={WINDOW_OPTIONS}
                  onValueChange={(value) => {
                    setIsEditingRange(false);
                    setTimeWindow({ days: Number(value) as TimelineDays });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={isEditingRange}
                  className={cn('px-2.5 font-normal', isEditingRange || 'begin' in timeWindow ? 'bg-muted' : 'text-muted-foreground')}
                  onClick={() => setIsEditingRange((editing) => !editing)}
                >自定义</Button>
              </div>
            </div>
          )}
          {isSideBySide && chatMode === 'closed' && <Button variant="outline" size="sm" className={cn(!hasDisplacementSeries && 'ms-auto')} onClick={showChat}>AI 调查</Button>}
        </div>
        {hasDisplacementSeries && isEditingRange && (
          <CustomRangeForm
            initial={'begin' in timeWindow ? timeWindow : undefined}
            onApply={(range) => {
              setTimeWindow(range);
              setIsEditingRange(false);
            }}
            onCancel={() => setIsEditingRange(false)}
          />
        )}
        {viewedCurrentWindow && findings.some((finding) => !finding.time) && <FindingChips findings={findings.filter((finding) => !finding.time)} className="mt-3" />}
        {viewedCurrentWindow && inspection && inspection.findings.length === 0 && inspection.reasons.length > 0 && (
          <p className="text-muted-foreground mt-2 text-sm wrap-anywhere">{inspection.reasons[0]}</p>
        )}

        <div className="mt-7 space-y-5">
          {'begin' in timeWindow && (
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
              <span>{timeWindow.begin === timeWindow.end ? timeWindow.begin : timeWindow.begin + ' 至 ' + timeWindow.end}</span>
              {!isSwitchingWindow && lastObservation && <span>最后观测 {formatChartTime(chartMillis(lastObservation))}</span>}
            </div>
          )}
          {hasError && (
            <p role="alert" className="text-muted-foreground text-sm">
              监测数据尚未载入。
              <Button type="button" variant="link" className="ms-1 h-auto p-0 align-baseline text-sm text-foreground underline" onClick={() => void timelineQuery.refetch()}>重试</Button>
            </p>
          )}
          {!timeline && !hasError && <Skeleton className="h-120 w-full" />}
          {timeline && !timeline.series && (
            <p className="text-muted-foreground text-sm">这个测点是基准站或中继站，没有位移序列。</p>
          )}
          {timeline?.series && !lastObservation && (
            <div className="text-muted-foreground text-sm">
              这段时间没有监测数据。
              {!isSwitchingWindow && inspectedDate && (viewedCurrentWindow || inspectedDate < timeWindow.begin || inspectedDate > timeWindow.end) && (
                <Button type="button" variant="link" className="h-auto px-1" onClick={() => setTimeWindow({ begin: inspectedDate, end: inspectedDate })}>
                  查看 {inspectedDate} 巡检观测
                </Button>
              )}
            </div>
          )}
          {timeline?.series && lastObservation && (
            <div
              aria-busy={isSwitchingWindow}
              className={cn('space-y-5 transition-opacity duration-200', isSwitchingWindow && 'opacity-50 delay-150')}
            >
              {'days' in timeWindow && (
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
                  <span>{seriesDateRange(timeline.series)}</span>
                  {lastObservation && <span>最后观测 {formatChartTime(chartMillis(lastObservation))}</span>}
                </div>
              )}
              <WindowMetrics data={timeline.series} />
              <DisplacementChart
                stationName={timeline.station_name}
                data={timeline.series}
                rainfall={dailyRainfall}
                rainEvents={rainfall?.events}
                rainfallDaily={rainfall?.daily}
                rainThresholdMm={rainfall?.threshold_mm}
                peers={peerSeries}
                findings={findings}
                onAsk={showChat}
                disabled={!conversationReady || isSwitchingWindow}
              />
              {rainfallQuery.isError && (
                <p className="text-muted-foreground text-sm">
                  降雨资料暂不可用。
                  <Button type="button" variant="link" className="ms-1 h-auto p-0 align-baseline text-sm text-foreground underline" onClick={() => void rainfallQuery.refetch()}>重试</Button>
                </p>
              )}
            </div>
          )}
        </div>

        {timeline && (
          <div className="mt-9">
            <h2 className="mb-2 text-sm font-medium">调查记录</h2>
            <StationRecords records={timeline.records} anchorId={recordAnchor} onOpened={(anchorId) => {
              setRecordAnchor(anchorId);
              showChat();
            }} />
          </div>
        )}
      </div>
    </section>
  );

  const chatPanel = (
    <aside aria-label="AI 调查" className="h-full min-w-0">
      <Thread
        autoFocus={false}
        resultAnchor={recordAnchor}
        placeholder={stationName ? `问问 ${stationName}…` : undefined}
        welcome={stationName ? <StationAsk stationName={stationName} inspection={inspection} /> : null}
      />
    </aside>
  );

  if (!stationName) {
    return dataPanel(false);
  }
  return (
    <StationConversation stationUuid={stationUuid} stationName={stationName} onComplete={investigationCompleted} active={active} onRunningChange={onRunningChange}>
        <div className="flex h-full min-h-0 flex-col">
          {!isSideBySide && <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            <Button type="button" variant="ghost" size="icon" aria-label="返回" onClick={returnFromStation}><ArrowLeftIcon className="size-4" /></Button>
            <h1 className="me-auto min-w-0 truncate text-sm font-medium">{stationName}</h1>
            {panel === 'chat' && <NewStationInvestigationButton onStarted={() => setRecordAnchor(undefined)} />}
            <Segmented
              label="测点页内容"
              value={panel}
              options={[{ value: 'data', label: '数据' }, { value: 'chat', label: 'AI 调查' }]}
              onValueChange={(value) => setPanel(value as Panel)}
            />
          </div>}
          <div ref={layoutRef} className="flex min-h-0 flex-1">
            <div
              inert={isSideBySide && chatMode === 'expanded'}
              aria-hidden={isSideBySide && chatMode === 'expanded' ? true : undefined}
              className={cn('h-full min-w-0 flex-1 overflow-hidden', !isSideBySide && panel !== 'data' && 'hidden')}
            >
              {dataPanel(true)}
            </div>
            <div ref={chatRef} id={`station-chat-${stationUuid}`} style={isSideBySide ? chatResize.style : undefined}
              data-mode={isSideBySide ? chatMode : undefined}
              inert={isSideBySide && chatMode === 'closed'}
              aria-hidden={isSideBySide && chatMode === 'closed' ? true : undefined}
              className={cn('relative flex h-full min-w-0 flex-col', isSideBySide ? 'station-chat-panel' : 'flex-1', !isSideBySide && panel !== 'chat' && 'hidden')}>
              {isSideBySide && <StationChatActions
                stationName={stationName}
                expanded={chatMode === 'expanded'}
                onBack={returnFromStation}
                onExpand={() => setChatMode(chatMode === 'expanded' ? 'split' : 'expanded')}
                onClose={() => setChatMode('closed')}
                onNewInvestigation={() => setRecordAnchor(undefined)}
              />}
              {isSideBySide && chatMode === 'split' && <PanelResizeHandle label="调整数据与调查宽度" panelId={`station-chat-${stationUuid}`} edge="left" {...chatResize.handleProps} />}
              <div className="min-h-0 flex-1">{chatPanel}</div>
            </div>
          </div>
        </div>
    </StationConversation>
  );
};
