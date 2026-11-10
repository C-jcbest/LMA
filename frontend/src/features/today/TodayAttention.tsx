import type { FC } from 'react';
import { ArrowRightIcon, RefreshCwIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { useInspection } from '@/features/inspection/InspectionContext';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { formatMillimeters, largestChange, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import { cn } from '@/lib/utils';
import type { InspectionStation } from '@/services/api';

const formatFinishedAt = (value: string) => {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
};

const AttentionRow: FC<{ station: InspectionStation }> = ({ station }) => {
  const { openStation } = useNavigation();
  const change = largestChange(station);
  // 和上次相比有变化、或已经调查过，都影响用户要不要再看一眼。
  const history: string[] = [];
  if (station.previous_screening !== null && station.previous_screening !== station.screening) {
    history.push(`上次巡检${investigationStatusLabel(station.previous_screening)}`);
  }
  if (station.last_conclusion) {
    history.push(`上次调查：${investigationStatusLabel(station.last_conclusion.status)}`);
  }

  return (
    <li>
      <button
        type="button"
        aria-label={`查看 ${station.station_name}`}
        onClick={() => openStation(station.station_uuid)}
        className="today-row hover:bg-muted/60 focus-visible:ring-ring w-full rounded-xl text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2.5">
            <StatusDot status={station.screening} />
            <span className="min-w-0 wrap-anywhere text-base font-semibold">{station.station_name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{station.group_name}</span>
          </span>
          {station.reasons.length > 0 && (
            <span className="text-muted-foreground mt-1 block ps-[1.125rem] text-sm leading-relaxed wrap-anywhere">
              {station.reasons.join('；')}
            </span>
          )}
          {history.length > 0 && (
            <span className="text-muted-foreground mt-1 block ps-[1.125rem] text-xs">{history.join(' · ')}</span>
          )}
        </span>
        <span className="today-row-trend"><TrendLine values={station.trend} emphasized /></span>
        {change && (
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

  const stations = latest?.stations ?? [];
  const hasResults = stations.length > 0;
  const isRunning = latest?.running != null;
  const needsLook = stations.filter((station) => station.screening === '建议调查');
  const quietCount = stations.filter((station) => station.screening === '未见明显变化').length;
  const unavailableCount = stations.length - needsLook.length - quietCount;

  let startLabel = hasResults ? '重新巡检' : '开始巡检';
  if (latest?.running) {
    startLabel = `巡检中 ${latest.running.completed_stations}/${latest.running.total_stations}`;
  }

  let headline = <>今天要查哪个测点？</>;
  if (hasResults && needsLook.length > 0) {
    headline = <>{stations.length} 个测点，<em className="text-status-attention not-italic">{needsLook.length} 个</em>建议调查</>;
  } else if (hasResults && quietCount === stations.length) {
    headline = <>{stations.length} 个测点未见明显变化</>;
  } else if (hasResults) {
    headline = <>{unavailableCount} 个测点的数据待核查</>;
  }

  return (
    <section aria-label="今日" className="aui-thread-welcome-root today mb-8">
      <h1 className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-[1.75rem]">{headline}</h1>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {latest?.inspection && <span className="tabular-nums">{formatFinishedAt(latest.inspection.finished_at)} 巡检</span>}
        <Button
          type="button"
          variant={hasResults ? 'ghost' : 'outline'}
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

      {needsLook.length > 0 && (
        <ul aria-label="建议调查的测点" className="mt-7 -mx-3 space-y-1">
          {needsLook.map((station) => <AttentionRow key={station.station_uuid} station={station} />)}
        </ul>
      )}

      {hasResults && (
        <button
          type="button"
          onClick={goStations}
          className="bg-muted/50 hover:bg-muted focus-visible:ring-ring text-muted-foreground group/all mt-5 flex min-h-12 w-full flex-wrap items-center gap-x-5 gap-y-1 rounded-xl px-4 py-2 text-start text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
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
