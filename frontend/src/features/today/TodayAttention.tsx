import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useAui } from '@assistant-ui/react';
import { ActivityIcon, ChevronRightIcon, RefreshCwIcon } from 'lucide-react';
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
    <li className="inspection-station">
      <button
        type="button"
        aria-label={`调查 ${station.station_name}`}
        onClick={prepareInvestigation}
        className="inspection-station-main hover:bg-muted/60 focus-visible:ring-ring min-w-0 flex-1 rounded-lg p-3 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', SCREENING_DOT_CLASS[station.screening])} aria-hidden />
          <span className="min-w-0 wrap-anywhere font-semibold">{station.station_name}</span>
          <span className="ms-auto shrink-0"><Sparkline values={station.trend} /></span>
        </span>
        <span className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="wrap-anywhere">{station.group_name}</span>
          {hasChanged && <span>此前{station.previous_screening}</span>}
        </span>
        {clues && <span className="mt-2 block text-sm leading-relaxed wrap-anywhere">{clues}</span>}
      </button>
      {conclusion && (
        <button
          type="button"
          title={conclusion.reason}
          aria-label={`打开 ${station.station_name} 的上次调查`}
          onClick={() => void aui.threads().switchToThread(conclusion.session_id)}
          className="inspection-history text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-9 items-center gap-1 rounded-md px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
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
    <Collapsible className="inspection-fold">
      <CollapsibleTrigger className="group/fold text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none">
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
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState(ALL_GROUPS);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (abortRef.current) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    try {
      const result = await client.getLatestInspection(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setLatest(result);
      setHasLoadError(false);
    } catch {
      if (!controller.signal.aborted) {
        setHasLoadError(true);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    setLatest(null);
    void load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const isRunning = latest?.running != null;
  useEffect(() => {
    if (!isRunning || isLoading) {
      return;
    }
    // 请求结束后才开始计时，慢接口不会被下一轮取消，也不累积并发请求。
    const timer = window.setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isRunning, isLoading, load]);

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
  const selectedGroup = groupOptions.includes(group) ? group : ALL_GROUPS;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (allStations ?? []).filter((station) => (
      (selectedGroup === ALL_GROUPS || station.group_name === selectedGroup)
      && (!query || station.station_name.toLowerCase().includes(query))
    ));
  }, [allStations, selectedGroup, search]);

  const hasResults = (allStations?.length ?? 0) > 0;
  const needsLook = visible.filter((station) => station.screening === '建议调查');
  const quiet = visible.filter((station) => station.screening === '未见明显变化');
  const unavailable = visible.filter((station) => station.screening === '数据不足' || station.screening === '暂无法分析');

  let startLabel = hasResults ? '重新巡检' : '开始巡检';
  if (latest?.running) {
    startLabel = `巡检中 ${latest.running.completed_stations}/${latest.running.total_stations}`;
  }

  return (
    <section aria-label="日常巡检" className="aui-thread-welcome-root inspection-dashboard mb-6">
      <div className="inspection-heading">
        <div>
          <p className="mb-3 flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground"><ActivityIcon className="size-4" aria-hidden />监测工作台</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {hasResults ? '今日关注' : '今天要查哪个测点？'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {hasResults ? '从变化线索出发，查看值得关注的测点。' : '发起一次巡检，或直接提问，查看测点的近期变化。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {latest?.inspection && (
            <span className="text-muted-foreground text-sm tabular-nums">{formatFinishedAt(latest.inspection.finished_at)} 巡检</span>
          )}
          <Button type="button" variant="outline" size="sm" disabled={isRunning || isStarting || isLoading} onClick={() => void start()}>
            <RefreshCwIcon className={cn('size-3.5', (isRunning || isStarting) && 'animate-spin motion-reduce:animate-none')} aria-hidden />
            {startLabel}
          </Button>
        </div>
      </div>
      {latest?.running && (
        <progress className="inspection-progress" aria-label="巡检进度" max={Math.max(1, latest.running.total_stations)} value={latest.running.completed_stations} />
      )}

      {hasLoadError && (
        <p role="alert" className="text-muted-foreground mt-3 text-sm">
          巡检结果暂时无法读取。
          <button type="button" disabled={isLoading || isStarting} className="ms-1 underline underline-offset-4 disabled:opacity-50" onClick={() => void load()}>重试</button>
        </p>
      )}
      {startError && <p role="alert" className="text-destructive mt-3 text-sm">巡检未能启动，请稍后重试。</p>}
      {latest?.latest_attempt?.status === 'error' && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          最近一次巡检失败，请重新巡检。{latest.inspection ? '下方保留上次成功结果。' : '你仍可直接提问。'}
        </p>
      )}
      {latest?.latest_attempt?.status === 'interrupted' && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          最近一次巡检已中断，请重新巡检。{latest.inspection ? '下方保留上次成功结果。' : '你仍可直接提问。'}
        </p>
      )}

      {hasResults && (
        <div className="mt-6 space-y-3">
          <dl className="inspection-overview" aria-label="当前筛选结果概览">
            <div><dt>建议调查</dt><dd className="text-status-attention">{needsLook.length}</dd></div>
            <div><dt>未见明显变化</dt><dd>{quiet.length}</dd></div>
            <div><dt>数据待核查</dt><dd>{unavailable.length}</dd></div>
          </dl>
          {(groupOptions.length > 1 || (allStations?.length ?? 0) >= SEARCH_VISIBLE_FROM) && (
            <div className="inspection-filters flex flex-wrap items-center gap-2">
              {groupOptions.length > 1 && groupOptions.length <= MAX_GROUP_OPTIONS && (
                <Segmented
                  label="分组"
                  value={selectedGroup}
                  options={[ALL_GROUPS, ...groupOptions].map((name) => ({ value: name, label: name }))}
                  onValueChange={setGroup}
                />
              )}
              {groupOptions.length > MAX_GROUP_OPTIONS && (
                <select
                  aria-label="分组"
                  value={selectedGroup}
                  onChange={(event) => setGroup(event.target.value)}
                  className="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
                >
                  {[ALL_GROUPS, ...groupOptions].map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
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
            <div className="inspection-priority">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3 pb-1">
                <h2 className="text-sm font-semibold">优先关注</h2>
                <span className="text-xs text-muted-foreground">选择测点，准备调查</span>
              </div>
              <ul aria-label="建议调查的测点" className="divide-y">
                {needsLook.map((station) => <StationRow key={station.station_uuid} station={station} />)}
              </ul>
            </div>
          )}
          {needsLook.length === 0 && visible.length > 0 && (
            <p className="text-muted-foreground px-2 text-sm">初筛未发现需要优先调查的测点。</p>
          )}
          {visible.length === 0 && <p className="text-muted-foreground px-2 text-sm">没有符合条件的测点。</p>}

          <FoldedStations label="数据不足或暂无法分析" stations={unavailable} />
          <FoldedStations label="未见明显变化" stations={quiet} />
        </div>
      )}
    </section>
  );
};
