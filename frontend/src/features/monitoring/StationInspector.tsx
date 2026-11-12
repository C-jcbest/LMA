import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive, Tabs } from 'radix-ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { appendToComposerDraft } from '@/lib/composer-draft';
import { PanelResizeHandle, usePanelResize } from '@/components/ui/panel-resize-handle';
import type { EvidenceSource, GnssArtifactData } from '@/types/envelope';
import { useChartColors } from './chartColors';
import { collectStations, type StationEvidence } from './investigation';
import { useStationInspector } from './StationInspectorContext';
import {
  buildTimelineOption,
  dailyRainfallWithin,
  displacementBasisLabel,
  displacementOf,
  referenceOf,
  formatChartTime,
  peerSeriesFor,
  seriesDuration,
  rangeQuestion,
  seriesLabel,
  type TimelineMode,
} from './timeline';
import type { ChartRange } from './TimelineChart';
import { GnssResultView } from './tools/GnssResultView';
import { NumericalResultView } from './tools/NumericalResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { StationStatus } from './tools/StationResultView';
import { WeatherResultView } from './tools/WeatherResultView';

const TimelineChart = lazy(() => import('./TimelineChart'));

const MILLIMETERS_PER_METER = 1000;

const formatSigned = (millimeters: number | null | undefined) => {
  if (millimeters === null || millimeters === undefined) return '—';
  return `${millimeters > 0 ? '+' : ''}${millimeters.toFixed(1)}`;
};

const METRIC_AXES = [
  { axis: 'n', label: '北向' },
  { axis: 'e', label: '东向' },
  { axis: 'u', label: '垂直' },
] as const;

/** 有固定参考的方向显示最新累计位移，并附本窗口净变化；没有参考的方向只能给本窗口净变化。 */
export const WindowMetrics: FC<{ data: GnssArtifactData }> = ({ data }) => {
  const reference = referenceOf(data);
  const displacement = displacementOf(data);
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
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      {METRIC_AXES.map(({ axis, label }) => {
        const hasReference = reference[axis] !== null;
        return (
          <div key={axis} className="min-w-0">
            <dt className="text-sm text-muted-foreground">{label}{hasReference ? '累计' : '本窗口变化'}</dt>
            <dd className="mt-0.5 text-xl font-medium tabular-nums">
              {formatSigned(hasReference ? latestOf(axis) : windowChange(axis))}
              <span className="ms-1 text-sm font-normal text-muted-foreground">mm</span>
            </dd>
            {hasReference && (
              <dd className="text-xs text-muted-foreground tabular-nums">本窗口 {formatSigned(windowChange(axis))} mm</dd>
            )}
          </div>
        );
      })}
      <div className="min-w-0">
        <dt className="text-sm text-muted-foreground">缺测</dt>
        <dd className="mt-0.5 text-xl font-medium tabular-nums">
          {data.summary.gaps.length}<span className="ms-1 text-sm font-normal text-muted-foreground">段</span>
        </dd>
      </div>
    </dl>
  );
};

interface TimelineViewProps {
  station: StationEvidence;
  seriesList: readonly GnssArtifactData[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  peers: readonly StationEvidence[];
}

const TimelineView: FC<TimelineViewProps> = ({ station, seriesList, selectedIndex, onSelectIndex, peers }) => {
  const aui = useAui();
  const { isSplit, composerInputRef, closeInspector } = useStationInspector();
  const chartColors = useChartColors();
  const [mode, setMode] = useState<TimelineMode>('components');
  const [range, setRange] = useState<ChartRange | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const data = seriesList[selectedIndex]!;
  const peerSeries = useMemo(
    () => peerSeriesFor(data, peers.map((peer) => ({ name: peer.name, series: peer.series.map((item) => item.data) }))),
    [data, peers],
  );
  const option = useMemo(() => {
    const rainfall = dailyRainfallWithin(station.weather.map((item) => item.data), data.begin_time, data.end_time);
    return buildTimelineOption(
      { data, rainfall, peers: peerSeries, mode: peerSeries.length > 0 ? mode : 'components' },
      chartColors,
    );
  }, [station.weather, data, peerSeries, mode, chartColors]);

  const askAboutRange = () => {
    if (!range) return;
    const stationIdentity = station.uuid ? `${station.name}（UUID：${station.uuid}）` : station.name;
    appendToComposerDraft(aui, rangeQuestion(stationIdentity, range));
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
          <Segmented
            label="时间窗口"
            value={String(selectedIndex)}
            options={seriesList.map((item, index) => ({ value: String(index), label: seriesLabel(item) }))}
            onValueChange={(value) => onSelectIndex(Number(value))}
          />
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
            onValueChange={(value) => setMode(value as TimelineMode)}
          />
        )}
      </div>

      <WindowMetrics data={data} />

      <div>
        <div className="flex min-h-8 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm text-muted-foreground tabular-nums">
            {range
              ? `${formatChartTime(range.start)} 至 ${formatChartTime(range.end)}`
              : `${displacementBasisLabel(data)}（mm）· ▲ 为台阶`}
          </p>
          {range && (
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setResetSignal((value) => value + 1)}>
                还原
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={askAboutRange}>
                追问这段
              </Button>
            </div>
          )}
        </div>
        <ErrorBoundary fallbackTitle="时间轴渲染异常">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <TimelineChart
              viewKey={`${station.id}:${data.begin_time}:${data.end_time}:${mode}`}
              option={option}
              label={`${station.name} ${seriesLabel(data)} 位移时间轴`}
              resetSignal={resetSignal}
              onRangeChange={setRange}
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

const EvidenceNotes: FC<{ station: StationEvidence }> = ({ station }) => {
  const envelopes = [...station.series, ...station.weather, ...station.site];
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

const TAB_CLASS = 'min-h-11 border-b-2 border-transparent px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:text-foreground';

interface InspectorBodyProps {
  station: StationEvidence;
  focusToolCallId?: string;
  stations: readonly StationEvidence[];
  title: ReactNode;
  onSelectStation: (stationId: string) => void;
  onClose: () => void;
}

const InspectorBody: FC<InspectorBodyProps> = ({ station, focusToolCallId, stations, title, onSelectStation, onClose }) => {
  // 默认看最长窗口：长期背景决定是否存在缓慢累积，短窗口用于放大细节。
  const sortedSeries = useMemo(
    () => [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data)),
    [station.series],
  );
  const seriesList = useMemo(() => sortedSeries.map((item) => item.data), [sortedSeries]);
  const [selectedIndex, setSelectedIndex] = useState(
    () => Math.max(0, sortedSeries.findIndex((item) => item.toolCallId === focusToolCallId)),
  );

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
  const isSiteFocused = station.site.some((item) => item.toolCallId === focusToolCallId);
  let defaultTab = 'details';
  if (isSiteFocused || (hasSite && !hasTimeline)) {
    defaultTab = 'site';
  } else if (hasTimeline && !station.weather.some((item) => item.toolCallId === focusToolCallId)) {
    defaultTab = 'timeline';
  }
  const [activeTab, setActiveTab] = useState(defaultTab);

  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          {title}
          {station.status && <StationStatus status={station.status} />}
        </div>
        <div className="flex shrink-0 items-center">
          {stations.length > 1 && (
            <>
              <Button type="button" variant="ghost" size="icon" className="size-10" disabled={!previousStation} aria-label="上一个测点" onClick={() => onSelectStation(previousStation!.id)}>
                <ChevronLeftIcon className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-10" disabled={!nextStation} aria-label="下一个测点" onClick={() => onSelectStation(nextStation!.id)}>
                <ChevronRightIcon className="size-4" />
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" size="icon" className="size-10" aria-label="关闭依据" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="依据内容" className="flex shrink-0 gap-5 border-b px-4 sm:px-6">
          {hasTimeline && <Tabs.Trigger value="timeline" className={TAB_CLASS}>时间轴</Tabs.Trigger>}
          {hasSite && <Tabs.Trigger value="site" className={TAB_CLASS}>场地</Tabs.Trigger>}
          <Tabs.Trigger value="details" className={TAB_CLASS}>明细</Tabs.Trigger>
        </Tabs.List>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6">
          {/* 只保留当前测点的时间轴，切页签保留缩放与图例；换测点或关闭时释放。 */}
          {hasTimeline && (
            <Tabs.Content value="timeline" forceMount hidden={activeTab !== 'timeline'} className="focus-visible:outline-none">
              <TimelineView
                station={station}
                seriesList={seriesList}
                selectedIndex={selectedIndex}
                onSelectIndex={setSelectedIndex}
                peers={peers}
              />
            </Tabs.Content>
          )}
          {hasSite && (
            <Tabs.Content value="site" className="focus-visible:outline-none">
              <SiteEnvironmentResultView environment={station.site[station.site.length - 1]!.data} />
            </Tabs.Content>
          )}
          <Tabs.Content value="details" className="space-y-8 focus-visible:outline-none">
            {sortedSeries.filter((item) => Object.keys(item.data.features ?? {}).length > 0).map((item) => (
              <DetailSection key={item.toolCallId} title={`数值特征 · ${seriesLabel(item.data)}`}>
                <NumericalResultView data={item.data} />
              </DetailSection>
            ))}
            {hasTimeline && (
              <details className="rounded-lg border">
                <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium">
                  原始坐标 · {seriesLabel(seriesList[selectedIndex]!)}
                </summary>
                <div className="border-t p-3">
                  <GnssResultView data={seriesList[selectedIndex]!} />
                </div>
              </details>
            )}
            {station.weather.map((item, index) => (
              <DetailSection key={index} title="同期天气">
                <WeatherResultView data={item.data} />
              </DetailSection>
            ))}
          </Tabs.Content>
          <EvidenceNotes station={station} />
        </div>
      </Tabs.Root>
    </>
  );
};

/** 核查对象是测点：宽屏与对话并排可继续追问，窄屏全屏查看。 */
export const StationInspector: FC = () => {
  const { selection, isClosing, isSplit, openStation, closeInspector } = useStationInspector();
  const panelRef = useRef<HTMLElement>(null);
  const resize = usePanelResize({
    storageKey: 'lma-inspector-width',
    defaultWidth: Math.min(896, window.innerWidth * 0.56),
    minWidth: 420,
    maxWidth: 1000,
    side: 'right',
    panelRef,
    availableWidth: () => {
      const navigation = document.querySelector('[data-navigation-docked]');
      return window.innerWidth - (navigation?.getBoundingClientRect().width ?? 0) - 360;
    },
  });
  const messageContent = useAuiState((state) => (
    selection ? state.thread.messages.find((message) => message.id === selection.messageId)?.content : undefined
  ));
  const stations = useMemo(() => (messageContent ? collectStations(messageContent) : []), [messageContent]);
  const station = stations.find((item) => item.id === selection?.stationId);

  const hasLostSelection = selection !== null && !station;
  useEffect(() => {
    if (hasLostSelection) {
      closeInspector();
    }
  }, [hasLostSelection, closeInspector]);

  const isOpenBesideChat = station !== undefined && isSplit;
  useEffect(() => {
    if (!isOpenBesideChat) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // 菜单和弹窗处理 Esc 时会标记 defaultPrevented，此时不关闭检查器。
      if (event.key === 'Escape' && !event.defaultPrevented) {
        closeInspector();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpenBesideChat, closeInspector]);

  if (!station || !selection) {
    return null;
  }

  const title = <h2 className="min-w-0 truncate text-base font-medium">{station.name}</h2>;
  const selectStation = (stationId: string) => openStation({ messageId: selection.messageId, stationId });
  const close = () => closeInspector();
  const inspectorKey = `${station.id}:${selection.toolCallId ?? ''}`;

  if (isSplit) {
    return (
      <aside
        id="station-evidence"
        ref={panelRef}
        aria-label={`${station.name} 依据`}
        data-station-inspector=""
        data-state={isClosing ? 'closed' : 'open'}
        inert={isClosing}
        style={resize.style}
        className="inspector-panel relative flex h-full min-w-0 flex-col border-l bg-background pt-[env(safe-area-inset-top)]"
      >
        <PanelResizeHandle label="调整聊天与依据宽度" panelId="station-evidence" edge="left" {...resize.handleProps} />
        <InspectorBody
          key={inspectorKey}
          station={station}
          focusToolCallId={selection.toolCallId}
          stations={stations}
          title={title}
          onSelectStation={selectStation}
          onClose={close}
        />
      </aside>
    );
  }

  return (
    <DialogPrimitive.Root
      open={!isClosing}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-station-inspector=""
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="inspector-overlay fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] outline-none"
        >
          <InspectorBody
            key={inspectorKey}
            station={station}
            focusToolCallId={selection.toolCallId}
            stations={stations}
            title={<DialogPrimitive.Title asChild>{title}</DialogPrimitive.Title>}
              onSelectStation={selectStation}
            onClose={close}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
