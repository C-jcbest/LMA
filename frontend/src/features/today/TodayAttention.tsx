import { useEffect, useState, type FC } from 'react';
import { isInspectionFromToday } from './inspection-date';
import { ArrowRightIcon, RefreshCwIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useInspection } from '@/features/inspection/InspectionContext';
import { horizontalChange, HorizontalChange, JudgmentBadge, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import { cn } from '@/lib/utils';
import type { InspectionStation, JudgmentGroup, LatestInspection } from '@/services/api';

const formatFinishedAt = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
};

/** 首次读取巡检结果时的占位；延迟出现，读取很快时不闪一下，也不先显示“开始巡检”再跳成结果。 */
const TodaySkeleton: FC = () => (
  <div aria-hidden className="animate-in fade-in fill-mode-both [animation-delay:150ms] [animation-duration:200ms]">
    <Skeleton className="h-8 w-3/5 motion-reduce:animate-none" />
    <Skeleton className="mt-3 h-4 w-40 motion-reduce:animate-none" />
    <div className="mt-7 space-y-3">
      <Skeleton className="h-16 w-full rounded-xl motion-reduce:animate-none" />
      <Skeleton className="h-16 w-full rounded-xl motion-reduce:animate-none" />
    </div>
  </div>
);

/**
 * 页面打开期间完成了一次新巡检时返回 true，用来提示这次结果里哪些测点变了。
 * 以打开页面时已有的巡检为基准；之后再打开页面，不重复提示。
 */
function useInspectionFinishedWhileOpen(latest: LatestInspection | null) {
  const [baselineInspectionId, setBaselineInspectionId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (baselineInspectionId === undefined && latest) {
      setBaselineInspectionId(latest.inspection?.id ?? null);
    }
  }, [latest, baselineInspectionId]);
  return baselineInspectionId !== undefined && latest?.inspection != null && latest.inspection.id !== baselineInspectionId;
}

const AttentionRow: FC<{ station: InspectionStation; highlightChange: boolean }> = ({ station, highlightChange }) => {
  const { openStation } = useNavigation();
  const change = horizontalChange(station);
  const judgment = station.current;
  const isScreeningChanged = station.previous_screening !== null && station.previous_screening !== station.screening;

  return (
    <li>
      <button
        type="button"
        aria-label={`查看 ${station.station_name}`}
        onClick={() => openStation(station.station_uuid)}
        className={cn(
          'today-row hover:bg-muted/60 focus-visible:ring-ring w-full rounded-xl text-start transition-colors focus-visible:ring-2 focus-visible:outline-none',
          highlightChange && isScreeningChanged && 'row-changed',
        )}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="min-w-0 wrap-anywhere text-base font-semibold">{station.station_name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{station.group_name}</span>
            {judgment && <JudgmentBadge judgment={judgment} />}
          </span>
          {judgment?.changed_since_investigation && (
            <span className="mt-1 block text-xs font-medium text-status-attention">上次调查后有新变化</span>
          )}
          {judgment?.reason && (
            <span className="text-muted-foreground mt-1 block text-sm leading-relaxed wrap-anywhere">{judgment.reason}</span>
          )}
        </span>
        <span className="today-row-trend"><TrendLine values={station.trend} emphasized /></span>
        {change && <HorizontalChange change={change} className="today-row-change text-base font-medium" />}
      </button>
    </li>
  );
};

const LISTED_GROUPS: readonly { group: JudgmentGroup; label: string }[] = [
  { group: '需要处理', label: '需要处理' },
  { group: '持续关注', label: '持续关注' },
  { group: '数据问题', label: '数据问题' },
];

/**
 * 首页回答“目前哪些点需要我处理”：每个测点只显示一个当前判断（较新的调查结论优先），
 * 按需要处理、持续关注、数据问题分组；平稳的测点只给数量，在全部测点里查看。
 */
export const TodayAttention: FC = () => {
  const { goStations } = useNavigation();
  const { latest, isLoading, hasLoadError, isStarting, hasStartError, reload, start } = useInspection();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 60000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const historical = Boolean(latest?.inspection && !isInspectionFromToday(latest.inspection.finished_at, now));
  const isInspectionFinishedWhileOpen = useInspectionFinishedWhileOpen(latest);

  if (!latest && isLoading) {
    return (
      <section aria-label="今日" aria-busy className="aui-thread-welcome-root today mb-8">
        <TodaySkeleton />
      </section>
    );
  }

  const stations = latest?.stations ?? [];
  const hasResults = stations.length > 0;
  const isRunning = latest?.running != null;
  // 服务端已按当前判断排序；这里只按组切开。
  const byGroup = (group: JudgmentGroup) => stations.filter((station) => (station.current?.group ?? '数据问题') === group);
  const needsAction = byGroup('需要处理');
  const quietCount = byGroup('平稳').length;

  let startLabel = hasResults ? '重新巡检' : '开始巡检';
  if (latest?.running) {
    startLabel = `巡检中 ${latest.running.completed_stations}/${latest.running.total_stations}`;
  }

  let headline = <>今天要查哪个测点？</>;
  if (hasResults && needsAction.length > 0) {
    headline = <>{stations.length} 个测点，{needsAction.length} 个需要处理</>;
  } else if (hasResults && quietCount === stations.length) {
    headline = <>{stations.length} 个测点未见明显变化</>;
  } else if (hasResults) {
    headline = <>{stations.length} 个测点，没有需要处理的</>;
  }

  return (
    <section aria-label="今日" className="aui-thread-welcome-root today mb-8">
      <h1 className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-[1.75rem]">{historical && <>上次巡检 · </>}{headline}</h1>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {latest?.inspection && <time dateTime={latest.inspection.finished_at} className={cn('tabular-nums', historical && 'font-medium text-foreground')}>{formatFinishedAt(latest.inspection.finished_at)} 巡检</time>}
        <Button
          type="button"
          variant={hasResults && !historical ? 'ghost' : 'outline'}
          size="sm"
          disabled={isRunning || isStarting || isLoading}
          onClick={start}
          className={cn(hasResults && '-ms-2 text-muted-foreground')}
        >
          <RefreshCwIcon className={cn('size-3.5', (isRunning || isStarting) && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          {startLabel}
        </Button>
      </div>
      {latest?.running && (
        <progress className="inspection-progress" aria-label="巡检进度" max={Math.max(1, latest.running.total_stations)} value={latest.running.completed_stations} />
      )}

      {hasLoadError && (
        <p role="alert" className="text-muted-foreground mt-3 text-sm">
          巡检结果尚未载入。
          <button type="button" disabled={isLoading || isStarting} className="ms-1 underline underline-offset-4 disabled:opacity-50" onClick={reload}>重试</button>
        </p>
      )}
      {hasStartError && <p role="alert" className="text-destructive mt-3 text-sm">巡检未能启动，请稍后重试。</p>}
      {latest?.latest_attempt?.status === 'error' && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {latest.inspection ? '本次巡检未更新结果，当前显示上次记录。' : '本次巡检未完成。'}
        </p>
      )}
      {latest?.latest_attempt?.status === 'interrupted' && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {latest.inspection ? '巡检已中断，当前显示上次记录。' : '巡检已中断。'}
        </p>
      )}

      {LISTED_GROUPS.map(({ group, label }) => {
        const rows = byGroup(group);
        if (rows.length === 0) return null;
        return (
          <section key={group} aria-label={label} className="mt-7">
            <h2 className="text-muted-foreground mb-1 text-xs font-medium">{label} · {rows.length}</h2>
            <ul className="-mx-3 space-y-1">
              {rows.map((station) => (
                <AttentionRow key={station.station_uuid} station={station} highlightChange={isInspectionFinishedWhileOpen} />
              ))}
            </ul>
          </section>
        );
      })}

      {hasResults && (
        <button
          type="button"
          onClick={goStations}
          className="bg-muted/50 hover:bg-muted focus-visible:ring-ring text-muted-foreground group/all mt-5 flex min-h-12 w-full flex-wrap items-center gap-x-5 gap-y-1 rounded-xl px-4 py-2 text-start text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {quietCount > 0 && (
            <span className="inline-flex items-center gap-2"><StatusDot status="未见明显变化" />其余 {quietCount} 个未见明显变化</span>
          )}
          <span className="group-hover/all:text-foreground ms-auto inline-flex items-center gap-1">
            全部测点<ArrowRightIcon className="size-3.5" aria-hidden />
          </span>
        </button>
      )}
    </section>
  );
};
