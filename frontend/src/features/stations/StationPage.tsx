import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useAui, useAuiEvent, useAuiState } from '@assistant-ui/react';
import { ArrowLeftIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { useLmaClient, useSetFocusStation } from '@/app/providers/LmaClientContext';
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
import { buildTimelineOption, formatChartTime, rangeQuestion } from '@/features/monitoring/timeline';
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

const formatRecordDate = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(new Date(value));
};

const DisplacementChart: FC<{ stationName: string; data: GnssArtifactData; onAsk: () => void }> = ({ stationName, data, onAsk }) => {
  const aui = useAui();
  const chartColors = useChartColors();
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const option = useMemo(
    () => buildTimelineOption({ data, rainfall: [], candidates: [], peers: [], mode: 'components' }, chartColors),
    [data, chartColors],
  );

  const askAboutRange = () => {
    if (!range) {
      return;
    }
    appendToComposerDraft(aui, rangeQuestion(stationName, range));
    onAsk();
  };

  return (
    <div>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 truncate text-sm tabular-nums">
          {range ? `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}` : '相对窗口首点的变化，拖动可放大一段'}
        </p>
        {range && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setResetSignal((value) => value + 1)}>还原</Button>
            <Button type="button" variant="outline" size="sm" onClick={askAboutRange}>追问这段</Button>
          </div>
        )}
      </div>
      <ErrorBoundary fallbackTitle="时间轴渲染异常">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <TimelineChart
            viewKey={`${data.station_name}:${data.begin_time}:${data.end_time}`}
            option={option}
            label={`${stationName} 位移时间轴`}
            resetSignal={resetSignal}
            onRangeChange={setRange}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
};

const RecordList: FC<{ records: readonly StationRecord[]; onOpen: () => void }> = ({ records, onOpen }) => {
  const aui = useAui();
  const currentSessionId = useAuiState((state) => (
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId
  ));

  if (records.length === 0) {
    return <p className="text-muted-foreground text-sm">还没有调查过这个测点。</p>;
  }
  return (
    <ul className="-mx-3">
      {records.map((record) => (
        <li key={`${record.session_id}:${record.created_at}`}>
          <button
            type="button"
            aria-current={record.session_id === currentSessionId}
            onClick={() => {
              void aui.threads().switchToThread(record.session_id);
              onOpen();
            }}
            className="record-row hover:bg-muted/60 aria-[current=true]:bg-muted focus-visible:ring-ring w-full rounded-lg text-start text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="text-muted-foreground tabular-nums">{formatRecordDate(record.created_at)}</span>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <StatusDot status={record.status} />{investigationStatusLabel(record.status)}
            </span>
            <span className="text-muted-foreground min-w-0 truncate">{record.reason}</span>
          </button>
        </li>
      ))}
    </ul>
  );
};

/** 对话为空时的右侧面板：有初筛线索就提供一键调查，否则只留输入框。 */
const StationAsk: FC<{ stationName: string; inspection: InspectionStation | undefined }> = ({ stationName, inspection }) => {
  const aui = useAui();
  const needsLook = inspection?.screening === '建议调查';

  return (
    <div className="aui-thread-welcome-root flex flex-1 flex-col justify-end gap-3 pb-6">
      <p className="text-muted-foreground text-sm leading-relaxed">
        {needsLook
          ? 'AI 会结合同组测点、降雨和数据质量，判断这个变化是否需要处理。'
          : `直接提问，AI 会以 ${stationName} 为对象。`}
      </p>
      {needsLook && (
        <Button
          type="button"
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
export const StationPage: FC<{ stationUuid: string }> = ({ stationUuid }) => {
  const client = useLmaClient();
  const setFocusStation = useSetFocusStation();
  const { goStations } = useNavigation();
  const { latest } = useInspection();
  const { composerInputRef } = useStationInspector();
  const isSideBySide = useMediaQuery('(min-width: 1100px)');
  const [days, setDays] = useState<TimelineDays>(90);
  const [timeline, setTimeline] = useState<StationTimeline | null>(null);
  const [hasError, setHasError] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [panel, setPanel] = useState<Panel>('data');
  const loadedKeyRef = useRef('');

  // 一轮调查结束后结论可能更新，重新读取这个测点的记录。
  useAuiEvent('thread.runEnd', () => setReloadCount((count) => count + 1));

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

  useEffect(() => {
    setFocusStation(stationName ?? null);
    return () => setFocusStation(null);
  }, [stationName, setFocusStation]);

  const showChat = () => {
    setPanel('chat');
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const dataPanel = (
    <section aria-label="测点数据" className="h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="station-data">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="button" variant="ghost" size="icon" className="-ms-2 size-9 text-muted-foreground" aria-label="返回测点列表" onClick={goStations}>
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere">{stationName ?? '测点'}</h1>
          {groupName && <span className="text-muted-foreground text-sm">{groupName}</span>}
          {inspection && (
            <span className="bg-muted inline-flex min-h-7 items-center gap-2 rounded-full px-3 text-xs">
              <StatusDot status={inspection.screening} />{investigationStatusLabel(inspection.screening)}
            </span>
          )}
          <div className="ms-auto">
            <Segmented label="时间范围" value={String(days)} options={WINDOW_OPTIONS} onValueChange={(value) => setDays(Number(value) as TimelineDays)} />
          </div>
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
              <DisplacementChart stationName={timeline.station_name} data={timeline.series} onAsk={showChat} />
            </>
          )}
        </div>

        {timeline && (
          <div className="mt-9">
            <h2 className="mb-2 text-sm font-medium">调查记录</h2>
            <RecordList records={timeline.records} onOpen={() => setPanel('chat')} />
          </div>
        )}
      </div>
    </section>
  );

  const chatPanel = (
    <aside aria-label="AI 调查" className={cn('h-full min-w-0', isSideBySide ? 'w-[26rem] shrink-0 border-l' : 'flex-1')}>
      <Thread
        autoFocus={false}
        placeholder={stationName ? `问问 ${stationName}…` : undefined}
        welcome={stationName ? <StationAsk stationName={stationName} inspection={inspection} /> : null}
      />
    </aside>
  );

  if (isSideBySide) {
    return <div className="flex h-full min-h-0">{dataPanel}{chatPanel}</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-center border-b py-1.5">
        <Segmented
          label="测点页内容"
          value={panel}
          options={[{ value: 'data', label: '数据' }, { value: 'chat', label: 'AI 调查' }]}
          onValueChange={(value) => setPanel(value as Panel)}
        />
      </div>
      <div className="flex min-h-0 flex-1">{panel === 'data' ? dataPanel : chatPanel}</div>
    </div>
  );
};
