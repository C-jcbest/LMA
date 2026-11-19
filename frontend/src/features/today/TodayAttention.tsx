import { useEffect, useState, type FC } from 'react';
import { isInspectionFromToday } from './inspection-date';
import { ArrowRightIcon, RefreshCwIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { FindingChips, triggersOf } from '@/features/inspection/findings';
import { useInspection } from '@/features/inspection/InspectionContext';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { formatMillimeters, largestChange, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import { cn } from 'cn';
import type { InspectionStation, LatestInspection } from '@/services/api';

const formatFinishedAt = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
};

/** 首次读取巡检结果时的占位；延迟出现，读取很快时不闪一下，也不先显示“开始巡检”再跳成结果。 */
const TodaySkeleton: FC = () => (
  <div aria-hidden className="animate-in fade-in fill-mode-both [animation-delay:150ms] [animation-duration:200ms]">
    <Skeleton className="h-8 w-3/5" />
    <Skeleton className="mt-3 h-4 w-40" />
    <div className="mt-7 space-y-3">
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
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

/** 本次巡检之后登记的结论表示这条线索已经调查过；更早的结论只说明以前查过。 */
function investigationProgress(station: InspectionStation, inspectionFinishedAt: string | undefined) {
  const conclusion = station.last_conclusion;
  if (!conclusion) {
    return null;
  }
  const isAfterInspection = inspectionFinishedAt !== undefined
    && new Date(conclusion.created_at).getTime() >= new Date(inspectionFinishedAt).getTime();
  return { isAfterInspection, status: investigationStatusLabel(conclusion.status) };
}

const AttentionRow: FC<{ station: InspectionStation; inspectionFinishedAt: string | undefined; highlightChange: boolean }> = ({ station, inspectionFinishedAt, highlightChange }) => {
  const { openStation } = useNavigation();
  const leadTrigger = triggersOf(station.findings)[0];
  const change = largestChange(station);
  const isScreeningChanged = station.previous_screening !== station.screening;
  const isNew = station.previous_screening !== null && isScreeningChanged;
  const progress = investigationProgress(station, inspectionFinishedAt);

  return (
    <li className="animate-in fade-in duration-200">
      <button
        type="button"
        aria-label={`查看 ${station.station_name}`}
        onClick={() => openStation(station.station_uuid)}
        className={cn(
          'today-row w-full rounded-lg text-start transition hover:bg-muted/60 active:scale-99 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          highlightChange && isScreeningChanged && 'row-changed',
        )}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2.5">
            <StatusDot status={station.screening} />
            {/* 测点名是区分各行的依据，空间不够时先截断分组名。 */}
            <span className="max-w-full shrink-0 truncate text-base font-semibold">{station.station_name}</span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">{station.group_name}</span>
            {isNew && <span className="text-status-attention shrink-0 text-xs font-medium">新出现</span>}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 ps-4.5">
            <FindingChips findings={station.findings} limit={1} showAmount={false} />
            {progress && (
              <span className={cn('text-xs', progress.isAfterInspection ? 'text-foreground' : 'text-muted-foreground')}>
                {progress.isAfterInspection ? `已调查 · ${progress.status}` : `上次调查 · ${progress.status}`}
              </span>
            )}
          </span>
        </span>
        <span className="today-row-trend"><TrendLine values={station.trend} emphasized /></span>
        {leadTrigger?.value_mm != null && (
          <span className="today-row-change text-base font-medium tabular-nums">
            {formatMillimeters(leadTrigger.value_mm)}
            <span className="text-muted-foreground ms-1 text-xs font-normal">mm{leadTrigger.days ? ` / ${Math.round(leadTrigger.days)} 天` : ''}</span>
          </span>
        )}
        {leadTrigger?.value_mm == null && change && (
          <span className="today-row-change text-base font-medium tabular-nums">
            {formatMillimeters(change.millimeters)}
            <span className="text-muted-foreground ms-1 text-xs font-normal">mm {change.axis}</span>
          </span>
        )}
      </button>
    </li>
  );
};

/** 首页先回答“今天有没有要看的”；初筛结果不是调查结论，点测点看数据再决定是否调查。 */
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
  const needsLook = stations.filter((station) => station.screening === '建议调查');
  const quietCount = stations.filter((station) => station.screening === '未见明显变化').length;
  const unavailableCount = stations.length - needsLook.length - quietCount;
  const investigatedCount = needsLook
    .filter((station) => investigationProgress(station, latest?.inspection?.finished_at)?.isAfterInspection)
    .length;

  let startLabel = hasResults ? '重新巡检' : '开始巡检';
  if (latest?.running) {
    startLabel = `巡检中 ${latest.running.completed_stations}/${latest.running.total_stations}`;
  }

  let headline = <>今天要查哪个测点？</>;
  if (hasResults && needsLook.length > 0) {
    // 中文标题按短语换行（不在“测点”中间断开）。
    headline = (
      <>
        <span className="whitespace-nowrap">{stations.length} 个测点，</span>
        <span className="whitespace-nowrap"><em className="text-status-attention not-italic">{needsLook.length} 个</em>建议调查</span>
      </>
    );
  } else if (hasResults && quietCount === stations.length) {
    headline = <>{stations.length} 个测点未见明显变化</>;
  } else if (hasResults) {
    headline = <>{unavailableCount} 个测点的数据待核查</>;
  }

  return (
    <section aria-label="今日" className="aui-thread-welcome-root today mb-8">
      <h1 className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-3xl">{historical && <span className="whitespace-nowrap">上次巡检 · </span>}{headline}</h1>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {latest?.inspection && <time dateTime={latest.inspection.finished_at} className={cn('tabular-nums', historical && 'font-medium text-foreground')}>{formatFinishedAt(latest.inspection.finished_at)} 巡检</time>}
        {needsLook.length > 0 && investigatedCount > 0 && (
          <span className="tabular-nums">已调查 {investigatedCount}/{needsLook.length}</span>
        )}
        <Button
          type="button"
          variant={hasResults && !historical ? 'ghost' : 'outline'}
          size="sm"
          disabled={isRunning || isStarting || isLoading}
          onClick={start}
          className={cn(hasResults && '-ms-2 text-muted-foreground')}
        >
          <RefreshCwIcon className={cn('size-3.5', (isRunning || isStarting) && 'animate-spin')} aria-hidden />
          {startLabel}
        </Button>
      </div>
      {latest?.running && (
        <Progress
          className="mt-4 h-1 bg-muted"
          aria-label="巡检进度"
          value={(latest.running.completed_stations / Math.max(1, latest.running.total_stations)) * 100}
        />
      )}

      {hasLoadError && (
        <p role="alert" className="text-muted-foreground mt-3 text-sm">
          巡检结果尚未载入。
          <Button type="button" variant="link" className="ms-1 h-auto p-0 align-baseline text-sm text-foreground underline" disabled={isLoading || isStarting} onClick={reload}>重试</Button>
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

      {needsLook.length > 0 && (
        <ul aria-label="建议调查的测点" className="mt-7 -mx-3 space-y-1">
          {needsLook.map((station) => (
            <AttentionRow key={station.station_uuid} station={station} inspectionFinishedAt={latest?.inspection?.finished_at} highlightChange={isInspectionFinishedWhileOpen} />
          ))}
        </ul>
      )}

      {hasResults && (
        <button
          type="button"
          onClick={goStations}
          className="group/all mt-5 flex min-h-12 w-full flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-start text-sm text-muted-foreground transition hover:bg-muted active:scale-99 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {quietCount > 0 && (
            <span className="inline-flex items-center gap-2"><StatusDot status="未见明显变化" />{quietCount} 个未见明显变化</span>
          )}
          {unavailableCount > 0 && (
            <span className="inline-flex items-center gap-2"><StatusDot status={null} />{unavailableCount} 个数据待核查</span>
          )}
          <span className="group-hover/all:text-foreground ms-auto inline-flex items-center gap-1">
            全部测点<ArrowRightIcon className="size-3.5" aria-hidden />
          </span>
        </button>
      )}
    </section>
  );
};
