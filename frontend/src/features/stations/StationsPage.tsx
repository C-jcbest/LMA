import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useNavigation } from '@/app/navigation';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useInspection } from '@/features/inspection/InspectionContext';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { formatMillimeters, largestChange, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import type { InspectionStation, Screening, StationDirectoryEntry } from '@/services/api';
import { Button } from '@/components/ui/button';

interface StationListItem extends Omit<InspectionStation, 'screening'> {
  screening: Screening | null;
}

type Filter = 'all' | 'attention' | 'unavailable';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'attention', label: '建议调查' },
  { value: 'unavailable', label: '数据待核查' },
];

// 需要看的排在前面，其次是数据有问题的，正常的放最后。
const SCREENING_ORDER: Record<Screening, number> = {
  建议调查: 0,
  数据不足: 1,
  暂无法分析: 1,
  未见明显变化: 2,
};

const matchesFilter = (station: StationListItem, filter: Filter) => {
  if (filter === 'attention') {
    return station.screening === '建议调查';
  }
  if (filter === 'unavailable') {
    return station.screening === '数据不足' || station.screening === '暂无法分析';
  }
  return true;
};

const EMPTY_DIRECTORY: StationDirectoryEntry[] = [];

const StationRow: FC<{ station: StationListItem }> = ({ station }) => {
  const { openStation } = useNavigation();
  const change = largestChange(station);
  const isAttention = station.screening === '建议调查';

  return (
    <li className="animate-in fade-in duration-200">
      <button
        type="button"
        onClick={() => openStation(station.station_uuid)}
        className="station-row w-full rounded-lg text-start transition hover:bg-muted/60 active:scale-99 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot status={station.screening} />
          {/* 测点名是区分各行的唯一依据，空间不够时先截断分组名。 */}
          <span className="max-w-full shrink-0 truncate font-medium">{station.station_name}</span>
          <span className="text-muted-foreground min-w-0 truncate text-xs">{station.group_name}</span>
        </span>
        <span className="station-row-trend"><TrendLine values={station.trend} emphasized={isAttention} className="h-7" /></span>
        <span className="station-row-note text-muted-foreground min-w-0 truncate text-sm">
          {station.reasons[0] ?? (station.screening ? investigationStatusLabel(station.screening) : '未巡检')}
        </span>
        <span className="text-end text-sm tabular-nums">
          {change ? `${formatMillimeters(change.millimeters)} mm` : <span className="text-muted-foreground">—</span>}
        </span>
      </button>
    </li>
  );
};

/** 全部测点：按是否需要看排序，点一行进入测点页。 */
export const StationsPage: FC = () => {
  const { latest } = useInspection();
  const client = useLmaClient();
  const stationsQuery = useQuery({
    queryKey: ['stations'],
    queryFn: ({ signal }) => client.listStations(signal),
  });
  const directory = stationsQuery.data ?? EMPTY_DIRECTORY;
  const isLoading = stationsQuery.isFetching;
  const hasLoadError = stationsQuery.isError;
  const reload = () => {
    void stationsQuery.refetch();
  };
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const stations = useMemo<StationListItem[]>(() => {
    const inspections = new Map(latest?.stations.map((station) => [station.station_uuid, station]));
    return directory.map((station) => ({
      reasons: [], metrics: {}, trend: [], previous_screening: null, last_conclusion: null, screening: null,
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
      .sort((a, b) => (
        (a.screening ? SCREENING_ORDER[a.screening] : 3) - (b.screening ? SCREENING_ORDER[b.screening] : 3)
        || a.station_name.localeCompare(b.station_name, 'zh-CN')
      ));
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
            <Button type="button" variant="link" className="ms-1 h-auto p-0 align-baseline text-sm text-foreground underline" disabled={isLoading} onClick={reload}>重试</Button>
          </p>
        )}
        {!hasStations && isLoading && (
          // 延迟出现，读取很快时不闪一下。
          <div aria-hidden className="animate-in fade-in fill-mode-both mt-5 space-y-2 [animation-delay:150ms] [animation-duration:200ms]">
            <Skeleton className="h-8 w-64" />
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
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
            <ul aria-label="测点列表" className="station-list mt-3 -mx-3 divide-y divide-transparent">
              {visible.map((station) => <StationRow key={station.station_uuid} station={station} />)}
            </ul>
            {visible.length === 0 && <p className="text-muted-foreground mt-4 text-sm">没有符合条件的测点。</p>}
          </>
        )}
      </section>
    </div>
  );
};
