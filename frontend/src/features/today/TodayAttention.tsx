import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useAui } from '@assistant-ui/react';
import { ChevronRightIcon } from 'lucide-react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sparkline } from '@/features/monitoring/InvestigationProcess';
import { useStationInspector } from '@/features/monitoring/StationInspectorContext';
import { cn } from '@/lib/utils';
import type { InspectionStation, LatestInspection, Screening } from '@/services/api';

const POLL_INTERVAL_MS = 2000;
const SEARCH_VISIBLE_FROM = 8;
const MAX_GROUP_OPTIONS = 6;
const ALL_GROUPS = '全部';

const SCREENING_DOT_CLASS: Record<Screening, string> = {
  建议调查: 'bg-status-attention',
  未见明显变化: 'bg-status-normal',
  数据不足: 'bg-status-unknown',
  暂无法分析: 'bg-status-unknown',
};

const formatFinishedAt = (value: string) => {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const StationRow: FC<{ station: InspectionStation }> = ({ station }) => {
  const aui = useAui();
  const { composerInputRef } = useStationInspector();
  const clues = station.reasons.join('；');

  // 只填入输入框：一次调查要消耗模型和上游请求，是否发起由用户确认。
  const prepareInvestigation = () => {
    aui.composer().setText(`调查 ${station.station_name} 的近期变化。${clues ? `初筛线索：${clues}` : ''}`);
    composerInputRef.current?.focus();
  };

  const conclusion = station.last_conclusion;
  const hasChanged = station.previous_screening !== null && station.previous_screening !== station.screening;

  return (
    <li className="flex flex-col items-stretch sm:flex-row">
      <button
        type="button"
        aria-label={`调查 ${station.station_name}`}
        onClick={prepareInvestigation}
        className="hover:bg-muted/60 focus-visible:ring-ring min-w-0 flex-1 rounded-md px-2 py-2 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', SCREENING_DOT_CLASS[station.screening])} aria-hidden />
          <span className="max-w-[60%] shrink-0 truncate font-medium">{station.station_name}</span>
          <span className="text-muted-foreground min-w-0 truncate text-sm">{station.group_name}</span>
          {hasChanged && <span className="text-muted-foreground shrink-0 text-sm">此前{station.previous_screening}</span>}
          <span className="ms-auto shrink-0"><Sparkline values={station.trend} /></span>
        </span>
        {clues && <span className="text-muted-foreground mt-0.5 block text-sm wrap-break-word">{clues}</span>}
      </button>
      {conclusion && (
        <button
          type="button"
          title={conclusion.reason}
          aria-label={`打开 ${station.station_name} 的上次调查`}
          onClick={() => void aui.threads().switchToThread(conclusion.session_id)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-8 shrink-0 items-center gap-0.5 self-start rounded-md px-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none sm:self-auto"
        >
          上次{conclusion.status}
          <ChevronRightIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
};

const FoldedStations: FC<{ label: string; stations: InspectionStation[] }> = ({ label, stations }) => {
  if (stations.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/fold text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-8 items-center gap-1 rounded-md px-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none">
        {label} {stations.length} 个
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/fold:rotate-90 motion-reduce:transition-none" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul>{stations.map((station) => <StationRow key={station.station_uuid} station={station} />)}</ul>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** 新会话的首页：先看今天哪些点值得调查，初筛结果不是调查结论。 */
export const TodayAttention: FC = () => {
  const client = useLmaClient();
  const [latest, setLatest] = useState<LatestInspection | null>(null);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState(ALL_GROUPS);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setLatest(await client.getLatestInspection(controller.signal));
      setHasLoadError(false);
    } catch {
      if (!controller.signal.aborted) {
        setHasLoadError(true);
      }
    }
  }, [client]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const isRunning = latest?.running != null;
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, load]);

  const start = async () => {
    setIsStarting(true);
    setStartError(false);
    try {
      await client.startInspection();
      await load();
    } catch {
      setStartError(true);
    } finally {
      setIsStarting(false);
    }
  };

  const allStations = latest?.stations;
  const groupOptions = useMemo(
    () => [...new Set((allStations ?? []).map((station) => station.group_name))].sort(),
    [allStations],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (allStations ?? []).filter((station) => (
      (group === ALL_GROUPS || station.group_name === group)
      && (!query || station.station_name.toLowerCase().includes(query))
    ));
  }, [allStations, group, search]);

  const hasResults = (allStations?.length ?? 0) > 0;
  const needsLook = visible.filter((station) => station.screening === '建议调查');
  const quiet = visible.filter((station) => station.screening === '未见明显变化');
  const unavailable = visible.filter((station) => station.screening === '数据不足' || station.screening === '暂无法分析');

  let startLabel = hasResults ? '重新巡检' : '开始巡检';
  if (latest?.running) {
    startLabel = `巡检中 ${latest.running.completed_stations}/${latest.running.total_stations}`;
  }

  return (
    <div className="aui-thread-welcome-root mb-6 px-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
          {hasResults ? '今日关注' : '今天要查哪个测点？'}
        </h1>
        <div className="flex items-center gap-3">
          {latest?.inspection && (
            <span className="text-muted-foreground text-sm tabular-nums">{formatFinishedAt(latest.inspection.finished_at)} 巡检</span>
          )}
          <Button type="button" variant="outline" size="sm" disabled={isRunning || isStarting} onClick={() => void start()}>
            {startLabel}
          </Button>
        </div>
      </div>

      {hasLoadError && (
        <p role="alert" className="text-muted-foreground mt-3 text-sm">
          巡检结果暂时无法读取。
          <button type="button" className="ms-1 underline underline-offset-4" onClick={() => void load()}>重试</button>
        </p>
      )}
      {startError && <p role="alert" className="text-destructive mt-3 text-sm">巡检未能启动，请稍后重试。</p>}

      {hasResults && (
        <div className="mt-4 space-y-2">
          {(groupOptions.length > 1 || (allStations?.length ?? 0) >= SEARCH_VISIBLE_FROM) && (
            <div className="flex flex-wrap items-center gap-2">
              {groupOptions.length > 1 && groupOptions.length <= MAX_GROUP_OPTIONS && (
                <Segmented
                  label="分组"
                  value={group}
                  options={[ALL_GROUPS, ...groupOptions].map((name) => ({ value: name, label: name }))}
                  onValueChange={setGroup}
                />
              )}
              {(allStations?.length ?? 0) >= SEARCH_VISIBLE_FROM && (
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="搜索测点"
                  placeholder="搜索测点"
                  className="h-8 w-40 text-sm"
                />
              )}
            </div>
          )}

          {needsLook.length > 0 && (
            <ul aria-label="建议调查的测点">
              {needsLook.map((station) => <StationRow key={station.station_uuid} station={station} />)}
            </ul>
          )}
          {needsLook.length === 0 && visible.length > 0 && (
            <p className="text-muted-foreground px-2 text-sm">初筛未发现需要优先调查的测点。</p>
          )}
          {visible.length === 0 && <p className="text-muted-foreground px-2 text-sm">没有符合条件的测点。</p>}

          <FoldedStations label="数据不足或暂无法分析" stations={unavailable} />
          <FoldedStations label="未见明显变化" stations={quiet} />
        </div>
      )}
    </div>
  );
};
