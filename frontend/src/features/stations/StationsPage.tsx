import { cn } from 'cn';
import { lazy, Suspense, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useNavigation } from '@/app/navigation';
import { Input } from '@/components/ui/input';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useInspection } from '@/features/inspection/InspectionContext';
import { findingLabel, triggersOf } from '@/features/inspection/findings';
import { formatMillimeters, largestChange, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import type { InspectionStation, Screening, StationDirectoryEntry } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import type { MapStation } from '@/features/monitoring/StationMap';

const StationMap = lazy(() => import('@/features/monitoring/StationMap'));

interface StationListItem extends Omit<InspectionStation, 'screening'>, StationDirectoryEntry {
  screening: Screening | null;
}

type Filter = 'all' | 'attention' | 'unavailable';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'attention', label: '建议调查' },
  { value: 'unavailable', label: '数据待核查' },
];

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

function stationNote(station: StationListItem) {
  if (station.station_type === '基准站' || station.station_type === '中继站') {
    return station.station_type;
  }
  if (station.screening === null) {
    return '未巡检';
  }
  const lead = triggersOf(station.findings)[0];
  if (lead) {
    return findingLabel(lead);
  }
  if (station.screening === '未见明显变化') {
    return '平稳';
  }
  return station.reasons[0] ?? '';
}

function platformStatusClass(status: string) {
  if (status === '故障' || status === '告警') {
    return 'rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive';
  }
  return 'rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground';
}

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
          <span className="max-w-full shrink-0 truncate font-medium">{station.station_name}</span>
          {station.platform_status && <span className={cn('shrink-0', platformStatusClass(station.platform_status))}>{station.platform_status}</span>}
          <span className="text-muted-foreground min-w-0 truncate text-xs">{station.group_name}</span>
        </span>
        <span className="station-row-trend"><TrendLine values={station.trend} emphasized={isAttention} className="h-7" /></span>
        <span className="station-row-note text-muted-foreground min-w-0 truncate text-sm">
          {stationNote(station)}
        </span>
        <span className="text-end text-sm tabular-nums">
          {change ? `${formatMillimeters(change.millimeters)} mm` : <span className="text-muted-foreground">—</span>}
        </span>
      </button>
    </li>
  );
};

const ALL_GROUPS = '__all__';

const STATUS_COLOR_TOKENS: Record<string, string> = {
  需人工复核: '--status-critical',
  建议调查: '--status-attention',
  持续关注: '--status-attention',
  未见明显变化: '--status-normal',
};

function overviewMapStation(station: StationListItem): MapStation | null {
  if (station.latitude === null || station.longitude === null) {
    return null;
  }
  const status = station.last_conclusion?.status ?? station.screening;
  const north = station.metrics?.net_change_mm?.n;
  const east = station.metrics?.net_change_mm?.e;
  const hasHorizontal = typeof north === 'number' && typeof east === 'number';
  return {
    id: station.station_uuid,
    name: station.station_name,
    stationType: station.station_type,
    latitude: station.latitude,
    longitude: station.longitude,
    northMillimeters: hasHorizontal ? north : null,
    eastMillimeters: hasHorizontal ? east : null,
    cumulative: false,
    downslopeAzimuth: null,
    track: [],
    status: status ? investigationStatusLabel(status) : null,
    reason: station.last_conclusion?.reason ?? null,
    colorToken: (status && STATUS_COLOR_TOKENS[status]) || '--status-unknown',
  };
}

const GroupOverviewMap: FC<{ stations: readonly StationListItem[] }> = ({ stations }) => {
  const { openStation } = useNavigation();
  const mapStations = useMemo(
    () => stations.flatMap((station) => overviewMapStation(station) ?? []),
    [stations],
  );
  if (mapStations.length === 0) {
    return null;
  }
  return (
    <ErrorBoundary fallbackTitle="地图渲染异常">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <StationMap stations={mapStations} onSelect={openStation} selectLabel="打开测点 →" />
      </Suspense>
    </ErrorBoundary>
  );
};

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
  const [group, setGroup] = useState(ALL_GROUPS);

  const stations = useMemo<StationListItem[]>(() => {
    const inspections = new Map(latest?.stations.map((station) => [station.station_uuid, station]));
    return directory.map((station) => ({
      reasons: [], findings: [], metrics: {}, trend: [], previous_screening: null, last_conclusion: null, screening: null,
      ...inspections.get(station.station_uuid), ...station,
    }));
  }, [directory, latest]);
  const hasStations = (stations?.length ?? 0) > 0;
  const groups = useMemo(() => [...new Set(stations.map((station) => station.group_name))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [stations]);
  const activeGroup = groups.length === 1 ? groups[0]! : group;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (stations ?? [])
      .filter((station) => activeGroup === ALL_GROUPS || station.group_name === activeGroup)
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
  }, [stations, filter, search, activeGroup]);
  const groupStations = useMemo(() => stations.filter((station) => station.group_name === activeGroup), [stations, activeGroup]);
  const scopedStations = useMemo(
    () => stations.filter((station) => activeGroup === ALL_GROUPS || station.group_name === activeGroup),
    [stations, activeGroup],
  );
  const filterOptions = useMemo<SegmentedOption[]>(() => [
    { value: 'all', label: '全部', count: scopedStations.length },
    { value: 'attention', label: '建议调查', count: scopedStations.filter((item) => matchesFilter(item, 'attention')).length },
    { value: 'unavailable', label: '数据待核查', count: scopedStations.filter((item) => matchesFilter(item, 'unavailable')).length },
  ], [scopedStations]);

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <section aria-label="测点" className="page-column">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">测点</h1>
            {hasStations && (
              <span className="text-sm text-muted-foreground tabular-nums">{stations.length} 个</span>
            )}
          </div>
          {hasStations && (
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索测点"
              placeholder="搜索测点或分组"
              className="h-9 w-full max-w-full sm:w-64"
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
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {groups.length > 1 && (
                <Select value={group} onValueChange={setGroup}>
                  <SelectTrigger size="sm" aria-label="选择分组" className="min-w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_GROUPS}>全部分组</SelectItem>
                    {groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Segmented label="筛选" value={filter} options={filterOptions} onValueChange={(value) => setFilter(value as Filter)} />
            </div>
            {groups.length > 1 && activeGroup === ALL_GROUPS && (
              <div aria-label="按分组查看地图" className="mt-3 flex flex-wrap items-center gap-1.5">
                {groups.map((name) => {
                  const members = stations.filter((station) => station.group_name === name);
                  const hasAttention = members.some((station) => station.screening === '建议调查');
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setGroup(name)}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-full border bg-card/50 px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-98 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {hasAttention && <span className="size-1.5 rounded-full bg-status-attention" aria-hidden />}
                      <span>{name}</span>
                      <span className="tabular-nums text-muted-foreground/75">{members.length}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {activeGroup !== ALL_GROUPS && (
              <div role="region" aria-label={`${activeGroup}位置概览`} className="mt-4">
                <GroupOverviewMap stations={groupStations} />
              </div>
            )}
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
