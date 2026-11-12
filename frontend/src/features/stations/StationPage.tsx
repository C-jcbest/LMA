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
import { StatusDot } from '@/features/monitoring/status';
import { buildTimelineOption, displacementBasisLabel, formatChartTime, rangeQuestion } from '@/features/monitoring/timeline';
import type { ChartRange } from '@/features/monitoring/TimelineChart';
import { useMediaQuery } from '@/hooks/use-media-query';
import { appendToComposerDraft } from '@/lib/composer-draft';
import { cn } from '@/lib/utils';
import type { InspectionStation, StationRecord, StationTimeline, TimelineDays } from '@/services/api';
import type { GnssArtifactData } from '@/types/envelope';

const TimelineChart = lazy(() => import('@/features/monitoring/TimelineChart'));

const WINDOW_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];

type Panel = 'data' | 'chat';

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
      <span className="mr-auto text-sm font-medium">AI 调查</span>
      <NewStationInvestigationButton onStarted={onNewInvestigation} />
      <Button variant="ghost" size="icon" title={expanded ? '恢复分栏' : '展开调查'} aria-label={expanded ? '恢复分栏' : '展开调查'} onClick={onExpand}>
        {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </Button>
      <Button variant="ghost" size="icon" title="关闭调查面板" aria-label="关闭调查面板" onClick={onClose}><XIcon className="size-4" /></Button>
    </div>
  );
}

/** 历次调查在测点自己的对话栏里打开，用户不离开正在看的数据。 */
function StationRecords({ records, onOpened }: { records: readonly StationRecord[]; onOpened: (anchorId: string) => void }) {
  const aui = useAui();
  return (
    <RecordList records={records} onOpen={async (record) => {
      await aui.threads().switchToThread(record.session_id);
      onOpened(record.anchor_id);
    }} />
  );
}

const formatRecordDate = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(value));
};

const DisplacementChart: FC<{ stationName: string; data: GnssArtifactData; onAsk: () => void; disabled: boolean }> = ({ stationName, data, onAsk, disabled }) => {
  const aui = useAui();
  const { composerInputRef } = useStationInspector();
  const isLoading = useConversationLoading();
  const chartColors = useChartColors();
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const option = useMemo(
    () => buildTimelineOption({ data, rainfall: [], peers: [], mode: 'components' }, chartColors),
    [data, chartColors],
  );

  const askAbout = (target: ChartRange) => {
    appendToComposerDraft(aui, rangeQuestion(`${stationName}（UUID：${data.station_uuid}）`, target));
    onAsk();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  return (
    <div>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 truncate text-sm tabular-nums">
          {range ? `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}` : `${displacementBasisLabel(data)}（mm）`}
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
            viewKey={`${data.station_uuid}:${data.begin_time}:${data.end_time}`}
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

const RecordList: FC<{ records: readonly StationRecord[]; onOpen: (record: StationRecord) => Promise<void> }> = ({ records, onOpen }) => {
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

/** 对话为空时的右侧面板：有初筛线索就提供一键调查，否则只留输入框。 */
const StationAsk: FC<{ stationName: string; inspection: InspectionStation | undefined }> = ({ stationName, inspection }) => {
  const aui = useAui();
  const isLoading = useConversationLoading();
  const needsLook = inspection?.screening === '建议调查';

  return (
    <div className="aui-thread-welcome-root flex flex-col gap-3 py-5">
      <h2 className="text-lg font-semibold">{stationName}</h2>
      {needsLook && (
        <Button
          type="button"
          disabled={isLoading}
          className="self-start rounded-full"
          onClick={() => aui.thread().append({ role: 'user', content: [{ type: 'text', text: `调查 ${stationName} 的近期变化` }] })}
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
  const { returnFromStation } = useNavigation();
  const { latest } = useInspection();
  const isSideBySide = useMediaQuery('(min-width: 1100px)');
  const [days, setDays] = useState<TimelineDays>(90);
  const [timeline, setTimeline] = useState<StationTimeline | null>(null);
  const [hasError, setHasError] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [panel, setPanel] = useState<Panel>('data');
  const [chatMode, setChatMode] = useState<'split' | 'closed' | 'expanded'>('split');
  // 从调查记录打开的会话定位到那次结论；开始新调查后清除。
  const [recordAnchor, setRecordAnchor] = useState<string | undefined>(undefined);
  const chatRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const chatResize = usePanelResize({
    storageKey: 'lma-station-chat-width', defaultWidth: 416, minWidth: 320, maxWidth: 1000,
    side: 'right', panelRef: chatRef,
    availableWidth: () => (layoutRef.current?.clientWidth ?? window.innerWidth) - 360,
  });
  const loadedKeyRef = useRef('');

  // 一轮调查结束后结论可能更新，重新读取这个测点的记录。
  const investigationCompleted = () => {
    setReloadCount((count) => count + 1);
    void globalAui.threads().reload();
  };

  useEffect(() => {
    const controller = new AbortController();
    const key = `${stationUuid}:${days}`;
    // 换测点或窗口时清掉旧图；同一视图的刷新保留已显示的内容。
    if (loadedKeyRef.current !== key) {
      setTimeline(null);
    }
    setHasError(false);
    client.getStationTimeline(stationUuid, days, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) {
          return;
        }
        loadedKeyRef.current = key;
        setTimeline(result);
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
          <div className="ms-auto">
            <Segmented label="时间范围" value={String(days)} options={WINDOW_OPTIONS} onValueChange={(value) => setDays(Number(value) as TimelineDays)} />
          </div>
          {isSideBySide && chatMode === 'closed' && <Button variant="outline" size="sm" onClick={showChat}>AI 调查</Button>}
        </div>
        {inspection && inspection.reasons.length > 0 && (
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed wrap-anywhere">{inspection.reasons.join('；')}</p>
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
            <>
              <WindowMetrics data={timeline.series} />
              <DisplacementChart stationName={timeline.station_name} data={timeline.series} onAsk={showChat} disabled={!conversationReady} />
            </>
          )}
        </div>

        {timeline && (
          <div className="mt-9">
            <h2 className="mb-2 text-sm font-medium">调查记录</h2>
            <StationRecords records={timeline.records} onOpened={(anchorId) => {
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
            <div className={cn('h-full min-w-0 flex-1', (isSideBySide ? chatMode === 'expanded' : panel !== 'data') && 'hidden')}>{dataPanel(true)}</div>
            <div ref={chatRef} id={`station-chat-${stationUuid}`} style={isSideBySide && chatMode === 'split' ? chatResize.style : undefined}
              className={cn('relative flex h-full min-w-0 flex-col', isSideBySide && chatMode === 'split' ? 'w-[min(var(--panel-width),calc(100%-360px))] shrink-0 border-l' : 'flex-1', (isSideBySide ? chatMode === 'closed' : panel !== 'chat') && 'hidden')}>
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
