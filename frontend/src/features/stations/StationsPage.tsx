import { useEffect, useMemo, useState, type FC } from 'react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useNavigation } from '@/app/navigation';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useInspection } from '@/features/inspection/InspectionContext';
import { horizontalChange, HorizontalChange, JudgmentBadge } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import type { CurrentJudgment, InspectionStation, JudgmentGroup, Screening, StationDirectoryEntry } from '@/services/api';

interface StationListItem extends Omit<InspectionStation, 'screening' | 'current'> {
  screening: Screening | null;
  current: CurrentJudgment | null;
}

type Filter = 'all' | JudgmentGroup;

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '需要处理', label: '需要处理' },
  { value: '持续关注', label: '持续关注' },
  { value: '数据问题', label: '数据待核查' },
];

// 与首页同一顺序：需要处理、持续关注、数据问题、平稳，未巡检的放最后。
const GROUP_ORDER: Record<JudgmentGroup, number> = {
  需要处理: 0,
  持续关注: 1,
  数据问题: 2,
  平稳: 3,
};

const groupRank = (station: StationListItem) => (station.current ? GROUP_ORDER[station.current.group] : 4);

const matchesFilter = (station: StationListItem, filter: Filter) => filter === 'all' || station.current?.group === filter;

const StationRow: FC<{ station: StationListItem }> = ({ station }) => {
  const { openStation } = useNavigation();
  const change = horizontalChange(station);
  const isAttention = station.current?.group === '需要处理';

  return (
    <li>
      <button
        type="button"
        onClick={() => openStation(station.station_uuid)}
        className="station-row hover:bg-muted/60 focus-visible:ring-ring w-full rounded-lg text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 truncate font-medium">{station.station_name}</span>
          <span className="text-muted-foreground shrink-0 text-xs">{station.group_name}</span>
        </span>
        <span className="station-row-trend"><TrendLine values={station.trend} emphasized={isAttention} className="h-7" /></span>
        <span className="station-row-note min-w-0 truncate text-sm">
          {station.current
            ? <JudgmentBadge judgment={station.current} />
            : <span className="text-muted-foreground">未巡检</span>}
        </span>
        <span className="text-end text-sm">
          {change ? <HorizontalChange change={change} /> : <span className="text-muted-foreground">—</span>}
        </span>
      </button>
    </li>
  );
};

/** 全部测点：按是否需要看排序，点一行进入测点页。 */
export const StationsPage: FC = () => {
  const { latest } = useInspection();
  const client = useLmaClient();
  const [directory, setDirectory] = useState<StationDirectoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const reload = () => setReloadCount((count) => count + 1);
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setHasLoadError(false);
    client.listStations(controller.signal).then((stations) => {
      if (!controller.signal.aborted) {
        setDirectory(stations);
      }
    }, () => {
      if (!controller.signal.aborted) {
        setHasLoadError(true);
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    });
    return () => controller.abort();
  }, [client, reloadCount]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const stations = useMemo<StationListItem[]>(() => {
    const inspections = new Map(latest?.stations.map((station) => [station.station_uuid, station]));
    return directory.map((station) => ({
      reasons: [], metrics: {}, trend: [], previous_screening: null, last_conclusion: null, screening: null, current: null,
      ...inspections.get(station.station_uuid), ...station,
    }));
  }, [directory, latest]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (stations ?? [])
      .filter((station) => matchesFilter(station, filter))
      .filter((station) => (
        !query
        || station.station_name.toLowerCase().includes(query)
        || station.group_name.toLowerCase().includes(query)
      ))
      .sort((a, b) => groupRank(a) - groupRank(b) || a.station_name.localeCompare(b.station_name, 'zh-CN'));
  }, [stations, filter, search]);

  const hasStations = (stations?.length ?? 0) > 0;

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <section aria-label="测点" className="page-column">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">测点</h1>
          {hasStations && (
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索测点"
              placeholder="搜索测点或分组"
              className="h-9 w-52 max-w-full"
            />
          )}
        </div>

        {hasLoadError && (
          <p role="alert" className="text-muted-foreground mt-4 text-sm">
            测点尚未载入。
            <button type="button" disabled={isLoading} className="ms-1 underline underline-offset-4 disabled:opacity-50" onClick={reload}>重试</button>
          </p>
        )}
        {!hasStations && isLoading && (
          // 延迟出现，读取很快时不闪一下。
          <div aria-hidden className="animate-in fade-in fill-mode-both mt-5 space-y-2 [animation-delay:150ms] [animation-duration:200ms]">
            <Skeleton className="h-8 w-64 motion-reduce:animate-none" />
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full motion-reduce:animate-none" />
            ))}
          </div>
        )}
        {!hasStations && !isLoading && !hasLoadError && (
          <p className="text-muted-foreground mt-4 text-sm">暂无测点。</p>
        )}

        {hasStations && (
          <>
            <div className="mt-5">
              <Segmented label="筛选" value={filter} options={FILTERS} onValueChange={(value) => setFilter(value as Filter)} />
            </div>
            <ul aria-label="测点列表" className="mt-3 -mx-3 divide-y divide-transparent">
              {visible.map((station) => <StationRow key={station.station_uuid} station={station} />)}
            </ul>
            {visible.length === 0 && <p className="text-muted-foreground mt-4 text-sm">没有符合条件的测点。</p>}
          </>
        )}
      </section>
    </div>
  );
};
