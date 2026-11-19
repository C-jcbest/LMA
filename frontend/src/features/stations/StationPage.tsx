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
import { useStationInspector } from '@/features/monitoring/StationInspectorContext';
import { StatusDot } from '@/features/monitoring/status';
import { buildTimelineOption, displacementBasis, displacementBasisLabel, formatChartTime, peerSeriesFor, type DailyRainfall, type PeerSeries } from '@/features/monitoring/timeline';
import { RainEvents } from '@/features/monitoring/RainEvents';
import type { ChartRange } from '@/features/monitoring/TimelineChart';
import { useMediaQuery } from '@/hooks/use-media-query';
import { addAskTarget } from '@/features/monitoring/ask-targets';
import { cn } from 'cn';
import type { InspectionStation, StationRecord, StationWindow, TimelineDays } from '@/services/api';
import type { GnssArtifactData } from '@/types/envelope';

const TimelineChart = lazy(() => import('@/features/monitoring/TimelineChart'));

const WINDOW_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: 'custom', label: '自定义' },
];

const DAY_MILLIS = 86400e3;
const MAX_RANGE_DAYS = 366;
const toDateInput = (value: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(value);

/** 自定义起止日期（含当天，最长一年）；7 天以内看逐小时，更长看每日固定时刻。 */
const CustomRangeForm: FC<{
  initial?: { begin: string; end: string };
  onApply: (range: { begin: string; end: string }) => void;
  onCancel: () => void;
}> = ({ initial, onApply, onCancel }) => {
  const today = toDateInput(new Date());
  const [begin, setBegin] = useState(initial?.begin ?? toDateInput(new Date(Date.now() - 30 * DAY_MILLIS)));
  const [end, setEnd] = useState(initial?.end ?? today);
  const span = (new Date(end).getTime() - new Date(begin).getTime()) / DAY_MILLIS;
  const isValid = Boolean(begin && end) && span >= 0 && span <= MAX_RANGE_DAYS && end <= today;
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (isValid) {
          onApply({ begin, end });
        }
      }}
    >
      <Input type="date" aria-label="开始日期" value={begin} max={end || today} onChange={(event) => setBegin(event.target.value)} className="h-8 w-40" />
      <span className="text-muted-foreground">至</span>
      <Input type="date" aria-label="结束日期" value={end} min={begin} max={today} onChange={(event) => setEnd(event.target.value)} className="h-8 w-40" />
      <Button type="submit" size="sm" disabled={!isValid}>查看</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      {span > MAX_RANGE_DAYS && <span role="alert" className="text-muted-foreground">最长一年</span>}
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

/** 在测点自己的会话运行时里开始新调查；必须渲染在 StationConversation 内。 */
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

/** 宽屏对话栏的标题行；窄屏这些操作并入测点页顶部的一行。 */
function StationChatActions({ expanded, onExpand, onClose, onNewInvestigation }: {
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  onNewInvestigation: () => void;
}) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-1 border-b px-3">
      <StationInvestigationTitle />
      <NewStationInvestigationButton onStarted={onNewInvestigation} />
      <Button variant="ghost" size="icon" title={expanded ? '恢复分栏' : '展开调查'} aria-label={expanded ? '恢复分栏' : '展开调查'} onClick={onExpand}>
        {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </Button>
      <Button variant="ghost" size="icon" title="关闭调查面板" aria-label="关闭调查面板" onClick={onClose}><XIcon className="size-4" /></Button>
    </div>
  );
}

/** 历次调查在测点自己的对话栏里打开，用户不离开正在看的数据。 */
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
  /** 同组对比时的其他测点序列；为空时画本测点三个方向。 */
  peers: readonly PeerSeries[];
  onAsk: () => void;
  disabled: boolean;
}> = ({ stationName, data, rainfall, peers, onAsk, disabled }) => {
  const aui = useAui();
  const { composerInputRef } = useStationInspector();
  const isLoading = useConversationLoading();
  const chartColors = useChartColors();
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const mode = peers.length > 0 ? 'peers' : 'components';
  const option = useMemo(
    () => buildTimelineOption({ data, rainfall, peers, mode }, chartColors),
    [data, rainfall, peers, mode, chartColors],
  );

  const askAbout = (target: ChartRange) => {
    addAskTarget(aui, { stationUuid: data.station_uuid, stationName, ...target });
    onAsk();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  return (
    <div>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 truncate text-sm tabular-nums">
          {range && `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}`}
          {!range && displacementBasis(data) !== 'fixed' && displacementBasisLabel(data)}
        </p>
        {range && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setResetSignal((value) => value + 1)}>还原</Button>
            <Button type="button" variant="outline" size="sm" disabled={isLoading || disabled} onClick={() => askAbout(range)}>问当前范围</Button>
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
            askDisabled={isLoading || disabled}
          />
        </Suspense>
      </ErrorBoundary>
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

/** 对话为空时的右侧面板：有初筛线索就提供一键调查，否则只留输入框。 */
const StationAsk: FC<{ stationName: string; inspection: InspectionStation | undefined }> = ({ stationName, inspection }) => {
  const aui = useAui();
  const isLoading = useConversationLoading();
  const needsLook = inspection?.screening === '建议调查';
  // 问题里写明本次巡检的线索，模型和以后翻看记录的人都知道从哪里查起。
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

/** 测点页：左边直接读平台数据，不经过模型；右边是针对这个测点的对话。 */
export const StationPage: FC<{ stationUuid: string; active: boolean; onRunningChange: (running: boolean) => void }> = ({ stationUuid, active, onRunningChange }) => {
  const client = useLmaClient();
  const globalAui = useAui();
  const { returnFromStation, resultAnchor: recordAnchor, showStationResult: setRecordAnchor } = useNavigation();
  const { latest } = useInspection();
  const isSideBySide = useMediaQuery('(min-width: 1100px)');
  const queryClient = useQueryClient();
  const [timeWindow, setTimeWindow] = useState<StationWindow>({ days: 90 });
  const [isEditingRange, setIsEditingRange] = useState(false);
  const [showPeers, setShowPeers] = useState(false);
  // 切换窗口时旧图留在原处等新数据，页面不清空、不跳动。
  const timelineQuery = useQuery({
    queryKey: ['station-timeline', stationUuid, timeWindow],
    queryFn: ({ signal }) => client.getStationTimeline(stationUuid, timeWindow, signal),
    placeholderData: keepPreviousData,
  });
  const timeline = timelineQuery.data ?? null;
  // 降雨来自外部天气服务，单独读取：曲线先出来，降雨到了再叠加，失败不影响位移。
  const rainfallQuery = useQuery({
    queryKey: ['station-rainfall', stationUuid, timeWindow],
    queryFn: ({ signal }) => client.getStationRainfall(stationUuid, timeWindow, signal),
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
  // 从调查记录打开的会话定位到那次结论；开始新调查后清除。
  const chatRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const chatResize = usePanelResize({
    storageKey: 'lma-station-chat-width', defaultWidth: 416, minWidth: 320, maxWidth: 1000,
    side: 'right', panelRef: chatRef,
    availableWidth: () => (layoutRef.current?.clientWidth ?? window.innerWidth) - 360,
  });
  // 一轮调查结束后结论可能更新，重新读取这个测点的记录。
  const investigationCompleted = () => {
    void queryClient.invalidateQueries({ queryKey: ['station-timeline', stationUuid] });
    void globalAui.threads().reload();
  };

  // 同组对比：同组其他移动站在同一窗口的序列，只在打开开关后读取。
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
  const stationName = timeline?.station_name ?? inspection?.station_name;
  const groupName = timeline?.group_name ?? inspection?.group_name;

  const showChat = () => {
    setPanel('chat');
    setChatMode('split');
  };

  const dataPanel = (conversationReady: boolean) => (
    <section aria-label="测点数据" className="h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="station-data">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {(isSideBySide || !stationName) && <Button type="button" variant="ghost" size="icon" className="-ms-2 size-9 text-muted-foreground" aria-label="返回" onClick={returnFromStation}>
            <ArrowLeftIcon className="size-4" />
          </Button>}
          {(isSideBySide || !stationName) && <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere">{stationName ?? '测点'}</h1>}
          {groupName && <span className="text-muted-foreground text-sm">{groupName}</span>}
          {inspection && (
            <span className="bg-muted inline-flex min-h-7 items-center gap-2 rounded-full px-3 text-xs">
              <StatusDot status={inspection.screening} />{investigationStatusLabel(inspection.screening)}
            </span>
          )}
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {groupPeers.length > 0 && (
              <Toggle size="sm" variant="outline" pressed={showPeers} onPressedChange={setShowPeers}>同组对比</Toggle>
            )}
            <Segmented
              label="时间范围"
              value={'days' in timeWindow && !isEditingRange ? String(timeWindow.days) : 'custom'}
              options={WINDOW_OPTIONS}
              onValueChange={(value) => {
                if (value === 'custom') {
                  setIsEditingRange(true);
                  return;
                }
                setIsEditingRange(false);
                setTimeWindow({ days: Number(value) as TimelineDays });
              }}
            />
          </div>
          {isSideBySide && chatMode === 'closed' && <Button variant="outline" size="sm" onClick={showChat}>AI 调查</Button>}
        </div>
        {isEditingRange && (
          <CustomRangeForm
            initial={'begin' in timeWindow ? timeWindow : undefined}
            onApply={(range) => {
              setTimeWindow(range);
              setIsEditingRange(false);
            }}
            onCancel={() => setIsEditingRange(false)}
          />
        )}
        {'begin' in timeWindow && !isEditingRange && (
          <p className="text-muted-foreground mt-2 text-sm tabular-nums">{timeWindow.begin} 至 {timeWindow.end}</p>
        )}
        {inspection && inspection.findings.length > 0 && <FindingChips findings={inspection.findings} className="mt-3" />}
        {/* “暂无法分析”没有结构化线索，只有一句说明。 */}
        {inspection && inspection.findings.length === 0 && inspection.reasons.length > 0 && (
          <p className="text-muted-foreground mt-2 text-sm wrap-anywhere">{inspection.reasons[0]}</p>
        )}

        <div className="mt-7 space-y-5">
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
          {timeline?.series && timeline.series.points.length === 0 && (
            <p className="text-muted-foreground text-sm">这段时间没有监测数据。</p>
          )}
          {timeline?.series && timeline.series.points.length > 0 && (
            // 等新窗口时调暗旧图；延迟变暗，数据很快到达时不闪一下。
            <div
              aria-busy={isSwitchingWindow}
              className={cn('space-y-5 transition-opacity duration-200', isSwitchingWindow && 'opacity-50 delay-150')}
            >
              <WindowMetrics data={timeline.series} />
              <DisplacementChart stationName={timeline.station_name} data={timeline.series} rainfall={dailyRainfall} peers={peerSeries} onAsk={showChat} disabled={!conversationReady} />
              {rainfall && <RainEvents events={rainfall.events} daily={rainfall.daily} thresholdMm={rainfall.threshold_mm} />}
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
          {/* 窄屏只保留这一行：返回、测点名、数据/调查切换，调查时附带新调查。 */}
          {!isSideBySide && <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            <Button type="button" variant="ghost" size="icon" aria-label="返回" onClick={returnFromStation}><ArrowLeftIcon className="size-4" /></Button>
            {panel === 'chat' ? <StationInvestigationTitle /> : <h1 className="me-auto min-w-0 truncate text-sm font-medium">{stationName}</h1>}
            {panel === 'chat' && <NewStationInvestigationButton onStarted={() => setRecordAnchor(undefined)} />}
            <Segmented
              label="测点页内容"
              value={panel}
              options={[{ value: 'data', label: '数据' }, { value: 'chat', label: 'AI 调查' }]}
              onValueChange={(value) => setPanel(value as Panel)}
            />
          </div>}
          <div ref={layoutRef} className="flex min-h-0 flex-1">
            {/* 宽屏两栏都保持渲染，靠对话栏宽度过渡切换分栏、展开与关闭；窄屏一次只显示一栏。 */}
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
              {isSideBySide && <StationChatActions expanded={chatMode === 'expanded'}
                onExpand={() => setChatMode(chatMode === 'expanded' ? 'split' : 'expanded')}
                onClose={() => setChatMode('closed')}
                onNewInvestigation={() => setRecordAnchor(undefined)} />}
              {isSideBySide && chatMode === 'split' && <PanelResizeHandle label="调整数据与调查宽度" panelId={`station-chat-${stationUuid}`} edge="left" {...chatResize.handleProps} />}
              <div className="min-h-0 flex-1">{chatPanel}</div>
            </div>
          </div>
        </div>
    </StationConversation>
  );
};
