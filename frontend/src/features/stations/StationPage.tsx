import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ArrowLeftIcon, Maximize2, Minimize2, PlusIcon, XIcon } from 'lucide-react';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import { useNavigation } from '@/app/navigation';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useConversationLoading } from '@/app/providers/AssistantProvider';
import { StationConversation } from './StationConversation';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useInspection } from '@/features/inspection/InspectionContext';
import { useChartColors } from '@/features/monitoring/chartColors';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { WindowMetrics } from '@/features/monitoring/StationInspector';
import { useStationInspector } from '@/features/monitoring/StationInspectorContext';
import { JudgmentBadge, StatusDot } from '@/features/monitoring/status';
import { StationCompass } from '@/features/monitoring/StationCompass';
import { EVIDENCE_WINDOW_EVENT, type EvidenceWindowDetail } from '@/features/monitoring/StationTimelineCard';
import {
  buildTimelineOption,
  curveBasisLabel,
  displacementBasis,
  latestHorizontal,
  defaultCurveBasis,
  formatChartTime,
  timelineHeight,
  timelineSubGridCount,
  type CurveBasis,
} from '@/features/monitoring/timeline';
import type { ChartRange } from '@/features/monitoring/TimelineChart';
import { useMediaQuery } from '@/hooks/use-media-query';
import { addAskTarget } from '@/features/monitoring/ask-targets';
import { cn } from '@/lib/utils';
import type { CurrentJudgment, StationRecord, StationTimeline, TimelineDays } from '@/services/api';
import type { GnssArtifactData } from '@/types/envelope';

const TimelineChart = lazy(() => import('@/features/monitoring/TimelineChart'));

const WINDOW_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];

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

/** 测点页的方向罗盘：最新累计（或本窗口）水平位移的方位；测点页没有场地坡向，不比较顺坡。 */
const DirectionCompass: FC<{ data: GnssArtifactData }> = ({ data }) => {
  const horizontal = latestHorizontal(data);
  if (!horizontal) return null;
  const magnitude = Math.hypot(horizontal.north, horizontal.east);
  if (magnitude === 0) return null;
  const azimuth = ((Math.atan2(horizontal.east, horizontal.north) * 180) / Math.PI + 360) % 360;
  return (
    <StationCompass reading={{ azimuth, magnitudeMillimeters: magnitude, downslopeAzimuth: null, cumulative: displacementBasis(data) === 'fixed' }} />
  );
};

const DisplacementChart: FC<{
  stationName: string;
  data: GnssArtifactData;
  highlight: { begin: string; end: string } | null;
  onAsk: () => void;
  disabled: boolean;
}> = ({ stationName, data, highlight, onAsk, disabled }) => {
  const aui = useAui();
  const { composerInputRef } = useStationInspector();
  const isLoading = useConversationLoading();
  const chartColors = useChartColors();
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [basisChoice, setBasisChoice] = useState<CurveBasis | null>(null);
  const basis = basisChoice ?? defaultCurveBasis(data);
  const option = useMemo(
    () => buildTimelineOption({ data, rainfall: [], peers: [], mode: 'components', basis, highlight }, chartColors),
    [data, basis, highlight, chartColors],
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
          {range ? `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}` : `${curveBasisLabel(data, basis)}（mm）`}
        </p>
        {!range && (
          <Segmented
            label="曲线基准"
            value={basis}
            options={[
              { value: 'window', label: '本窗口变化' },
              { value: 'reference', label: '累计位移' },
            ]}
            onValueChange={(value) => setBasisChoice(value as CurveBasis)}
          />
        )}
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
            viewKey={`${data.station_uuid}:${data.begin_time}:${data.end_time}:${basis}`}
            option={option}
            height={timelineHeight(timelineSubGridCount(data, []), false)}
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
            className="record-row hover:bg-muted/60 aria-[current=true]:bg-muted focus-visible:ring-ring w-full rounded-lg text-start text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
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

/**
 * 一键调查的问题按当前判断写具体：有原因时直接问这条变化为什么、是否仍在继续，
 * 没有原因时退回问近期变化。由前端拼出，不需要模型。
 */
const quickQuestion = (stationName: string, judgment: CurrentJudgment | null | undefined): string => {
  const reason = judgment?.reason?.split('；')[0]?.trim();
  if (!reason) {
    return `调查 ${stationName} 的近期变化`;
  }
  return `${stationName}：${reason}。原因可能是什么？现在是否仍在继续？`;
};

/** 对话为空时的右侧面板：当前判断需要处理或持续关注时提供一键调查，否则只留输入框。 */
const StationAsk: FC<{ stationName: string; judgment: CurrentJudgment | null | undefined }> = ({ stationName, judgment }) => {
  const aui = useAui();
  const isLoading = useConversationLoading();
  const worthAsking = judgment?.group === '需要处理' || judgment?.group === '持续关注';
  const question = quickQuestion(stationName, judgment);

  return (
    <div className="aui-thread-welcome-root flex flex-col gap-3 py-5">
      <h2 className="text-lg font-semibold">{stationName}</h2>
      {worthAsking && (
        <Button
          type="button"
          disabled={isLoading}
          className="h-auto min-h-9 self-start rounded-2xl py-2 text-left whitespace-normal"
          onClick={() => aui.thread().append({ role: 'user', content: [{ type: 'text', text: question }] })}
        >
          {question}
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
  const [days, setDays] = useState<TimelineDays>(90);
  // 记下数据属于哪个窗口：切换窗口时旧图留在原处等新数据，页面不清空、不跳动。
  const [loaded, setLoaded] = useState<{ days: TimelineDays; timeline: StationTimeline } | null>(null);
  const timeline = loaded?.timeline ?? null;
  const isSwitchingWindow = loaded !== null && loaded.days !== days;
  const [hasError, setHasError] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  // 右侧回答里点开的依据窗口：左侧切到能覆盖它的最短时间范围，并标出这段。
  const [highlight, setHighlight] = useState<{ begin: string; end: string } | null>(null);
  useEffect(() => {
    const onEvidenceWindow = (event: Event) => {
      const detail = (event as CustomEvent<EvidenceWindowDetail>).detail;
      if (detail.stationId !== stationUuid) return;
      const spanDays = (Date.now() - new Date(detail.begin.replace(' ', 'T')).getTime()) / 86400000;
      const covering = ([7, 30, 90] as const).find((option) => option >= spanDays) ?? 90;
      setDays(covering);
      setHighlight({ begin: detail.begin, end: detail.end });
    };
    window.addEventListener(EVIDENCE_WINDOW_EVENT, onEvidenceWindow);
    return () => window.removeEventListener(EVIDENCE_WINDOW_EVENT, onEvidenceWindow);
  }, [stationUuid]);
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
    setReloadCount((count) => count + 1);
    void globalAui.threads().reload();
  };

  useEffect(() => {
    // 每个测点页按测点挂载，这里只会换窗口或刷新，新数据到达前保留已显示的内容。
    const controller = new AbortController();
    setHasError(false);
    client.getStationTimeline(stationUuid, days, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) {
          return;
        }
        setLoaded({ days, timeline: result });
      },
      () => {
        if (!controller.signal.aborted) {
          setHasError(true);
        }
      },
    );
    return () => controller.abort();
  }, [client, stationUuid, days, reloadCount]);

  const inspection = latest?.stations.find((station) => station.station_uuid === stationUuid);
  const stationName = timeline?.station_name ?? inspection?.station_name;
  const groupName = timeline?.group_name ?? inspection?.group_name;
  // 时间轴接口每次读取都带最新的当前判断（调查结束后会重新读取）；读到之前先用首页巡检结果。
  const judgment = timeline?.current ?? inspection?.current ?? null;

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
          {judgment && (
            <span className="bg-muted inline-flex min-h-7 items-center rounded-full px-3">
              <JudgmentBadge judgment={judgment} />
            </span>
          )}
          <div className="ms-auto">
            <Segmented label="时间范围" value={String(days)} options={WINDOW_OPTIONS} onValueChange={(value) => setDays(Number(value) as TimelineDays)} />
          </div>
          {isSideBySide && chatMode === 'closed' && <Button variant="outline" size="sm" onClick={showChat}>AI 调查</Button>}
        </div>
        {judgment?.changed_since_investigation && (
          <p className="mt-2 text-xs font-medium text-status-attention">上次调查后有新变化</p>
        )}
        {judgment?.reason && (
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed wrap-anywhere">{judgment.reason}</p>
        )}

        <div className="mt-7 space-y-5">
          {hasError && (
            <p role="alert" className="text-muted-foreground text-sm">
              监测数据尚未载入。
              <button type="button" className="ms-1 underline underline-offset-4" onClick={() => setReloadCount((count) => count + 1)}>重试</button>
            </p>
          )}
          {!timeline && !hasError && <Skeleton className="h-[30rem] w-full" />}
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
              className={cn('space-y-5 transition-opacity duration-200 motion-reduce:transition-none', isSwitchingWindow && 'opacity-50 delay-150')}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
                <div className="min-w-0 flex-1 basis-full sm:basis-[24rem]"><WindowMetrics data={timeline.series} /></div>
                <DirectionCompass data={timeline.series} />
              </div>
              <DisplacementChart stationName={timeline.station_name} data={timeline.series} highlight={highlight} onAsk={showChat} disabled={!conversationReady} />
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
        welcome={stationName ? <StationAsk stationName={stationName} judgment={judgment} /> : null}
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
            {/* 宽屏两栏都保持渲染，靠对话栏宽度过渡切换分栏、展开（对话加宽，左侧仍保留曲线）与关闭；窄屏一次只显示一栏。 */}
            <div className={cn('h-full min-w-0 flex-1 overflow-hidden', !isSideBySide && panel !== 'data' && 'hidden')}>
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
