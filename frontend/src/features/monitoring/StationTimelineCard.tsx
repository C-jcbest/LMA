import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ChevronDownIcon, Maximize2Icon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { useChartColors } from './chartColors';
import { isFromToolCall, type StationEvidence } from './investigation';
import { useStationInspector } from './StationInspectorContext';
import {
  buildTimelineOption,
  curveBasisLabel,
  dailyRainfallWithin,
  defaultCurveBasis,
  seriesDuration,
  timelineHeight,
  timelineSubGridCount,
} from './timeline';

const EvidenceChart = lazy(() => import('./EvidenceChart'));

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const NARROW_HEIGHT_REDUCTION = 32;

/** 正文引用了某条位移依据：时间轴卡切到那个窗口并滚动到眼前，而不是再嵌一张同测点的曲线。 */
export const FOCUS_EVIDENCE_EVENT = 'lma:focus-evidence';

export interface FocusEvidenceDetail {
  messageId: string;
  stationId: string;
  toolCallId: string;
}

export const timelineCardId = (messageId: string, stationId: string) => `timeline-${messageId}-${stationId}`;

/** 窗口标签只写长短和采样，如“90 天 · 日”“7 天 · 时”；日期范围在悬停提示里。 */
const windowLabel = (begin: string, end: string, hourly: boolean) => {
  const days = Math.max(1, Math.round((new Date(end.replace(' ', 'T')).getTime() - new Date(begin.replace(' ', 'T')).getTime()) / DAY_MILLIS));
  const range = days <= 3 ? `${begin.slice(5, 10)}~${end.slice(5, 10)}` : `${days} 天`;
  return `${range} · ${hourly ? '时' : '日'}`;
};

const isHourly = (data: { sampling?: { mode: string } | null }) => data.sampling?.mode !== 'sample_times';

/** 同一天起止、同样采样的窗口在标签上看不出区别（例如概览已取 90 天日采样，模型又取了一次），合成一个。 */
const windowKey = (data: { begin_time: string; end_time: string; sampling?: { mode: string } | null }) =>
  `${data.begin_time.slice(0, 10)}|${data.end_time.slice(0, 10)}|${isHourly(data) ? 'h' : 'd'}`;

interface StationTimelineCardProps {
  messageId: string;
  station: StationEvidence;
  /** 打开时先显示哪次取数的窗口；不传时显示最长窗口。 */
  initialToolCallId?: string;
}

/**
 * 一个测点一张时间轴卡：本次调查实际取过的窗口作为标签切换，默认最长窗口。
 * 卡片数量从“取数次数”降为“测点数”，读者不用把六张曲线在脑子里拼回一条时间线。
 */
export const StationTimelineCard: FC<StationTimelineCardProps> = ({ messageId, station, initialToolCallId }) => {
  const { openEvidence } = useStationInspector();
  const colors = useChartColors();
  const narrow = useMediaQuery('(max-width: 599px)');
  const cardRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [isPulsing, setIsPulsing] = useState(false);
  const allWindows = useMemo(
    () => [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data)),
    [station.series],
  );
  // 相同窗口保留最后取得的一次（数据最新）。
  const windows = useMemo(() => {
    const latest = new Map(allWindows.map((item) => [windowKey(item.data), item]));
    return [...latest.values()].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data));
  }, [allWindows]);
  /** 引用指向哪次取数，就选中与它窗口相同的那个标签。 */
  const keyOfToolCall = (toolCallId: string | undefined) => {
    const target = allWindows.find((item) => isFromToolCall(item, toolCallId));
    return target ? windowKey(target.data) : undefined;
  };
  const [selectedKey, setSelectedKey] = useState(() => keyOfToolCall(initialToolCallId) ?? (windows[0] && windowKey(windows[0].data)));
  const selected = windows.find((item) => windowKey(item.data) === selectedKey) ?? windows[0];

  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<FocusEvidenceDetail>).detail;
      if (detail.messageId !== messageId || detail.stationId !== station.id) {
        return;
      }
      const key = keyOfToolCall(detail.toolCallId);
      if (key) {
        setSelectedKey(key);
      }
      setIsOpen(true);
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setIsPulsing(true);
    };
    window.addEventListener(FOCUS_EVIDENCE_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVIDENCE_EVENT, onFocus);
  }, [messageId, station.id, allWindows]);

  // 流式输出时每个字都会重建依据数组；按依据编号判断内容是否变化，避免逐字重绘图表。
  const weatherKey = station.weather.map((item) => item.toolCallId).join();
  const weather = useMemo(() => station.weather.map((item) => item.data), [weatherKey]);
  const data = selected?.data;
  const rainfall = useMemo(
    () => (data ? dailyRainfallWithin(weather, data.begin_time, data.end_time) : []),
    [weather, data],
  );
  const basis = data ? defaultCurveBasis(data) : 'reference';
  const option = useMemo(
    () => (data ? buildTimelineOption({ data, rainfall, peers: [], mode: 'components', basis, compact: true }, colors) : null),
    [data, rainfall, basis, colors],
  );
  if (!selected || !data || !option) {
    return null;
  }
  const height = timelineHeight(timelineSubGridCount(data, rainfall), true) - (narrow ? NARROW_HEIGHT_REDUCTION : 0);
  const title = `${station.name} 时间轴`;

  return (
    <figure
      ref={cardRef}
      id={timelineCardId(messageId, station.id)}
      data-slot="evidence-card"
      data-state={isOpen ? 'open' : 'closed'}
      className={cn('evidence-card not-prose', isPulsing && 'evidence-card-pulse')}
      onAnimationEnd={() => setIsPulsing(false)}
    >
      <figcaption className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sm font-medium">{title}</span>
            <span className="ms-2 text-xs text-muted-foreground">{curveBasisLabel(data, basis)}</span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !isOpen && '-rotate-90')}
          />
        </button>
        <button
          type="button"
          onClick={() => openEvidence({ messageId, stationId: station.id, toolCallId: selected.sourceToolCallId })}
          aria-label={`展开${title}`}
          title={`展开${title}`}
          className="evidence-card-open inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Maximize2Icon className="size-4" aria-hidden />
        </button>
      </figcaption>
      {isOpen && (
        <div className="pt-1">
          {windows.length > 1 && (
            <div role="tablist" aria-label="时间窗口" className="mb-1 flex flex-wrap gap-1">
              {windows.map((item) => {
                const isSelected = item.toolCallId === selected.toolCallId;
                return (
                  <button
                    key={windowKey(item.data)}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    title={`${item.data.begin_time.slice(0, 16)} 至 ${item.data.end_time.slice(0, 16)}`}
                    onClick={() => setSelectedKey(windowKey(item.data))}
                    className={cn(
                      'min-h-7 rounded-full px-2.5 text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      isSelected ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-background hover:text-foreground',
                    )}
                  >
                    {windowLabel(item.data.begin_time, item.data.end_time, isHourly(item.data))}
                  </button>
                );
              })}
            </div>
          )}
          <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
            <EvidenceChart option={option} label={`${station.name} ${windowLabel(data.begin_time, data.end_time, isHourly(data))} 位移曲线`} height={height} />
          </Suspense>
        </div>
      )}
    </figure>
  );
};
