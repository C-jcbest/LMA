import { lazy, Suspense, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useNavigation } from '@/app/navigation';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
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

/** 台账一行加上最近巡检结果；还没巡检过的测点 screening 为 null。 */
interface StationListItem extends Omit<InspectionStation, 'screening'>, StationDirectoryEntry {
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

/** 列表行的一句话：首条调查理由的短标签，其次是数据说明；状态已由圆点表达，不再重复。 */
function stationNote(station: StationListItem) {
  if (station.screening === null) {
    return '未巡检';
  }
  const lead = triggersOf(station.findings)[0];
  if (lead) {
    return findingLabel(lead);
  }
  if (station.screening === '未见明显变化') {
    return '';
  }
  return station.reasons[0] ?? '';
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
          {/* 测点名是区分各行的唯一依据，空间不够时先截断分组名。 */}
          <span className="max-w-full shrink-0 truncate font-medium">{station.station_name}</span>
          {station.platform_status && <span className="text-status-attention shrink-0 text-xs font-medium">{station.platform_status}</span>}
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

/** 分组地图上的测点：最近调查结论优先于初筛着色，箭头为巡检 90 天水平净变化方向。 */
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
  const [group, setGroup] = useState(ALL_GROUPS);

  const stations = useMemo<StationListItem[]>(() => {
    const inspections = new Map(latest?.stations.map((station) => [station.station_uuid, station]));
    return directory.map((station) => ({
      reasons: [], findings: [], metrics: {}, trend: [], previous_screening: null, last_conclusion: null, screening: null,
      ...inspections.get(station.station_uuid), ...station,
    }));
  }, [directory, latest]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (stations ?? [])
      .filter((station) => group === ALL_GROUPS || station.group_name === group)
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
  }, [stations, filter, search, group]);

  const hasStations = (stations?.length ?? 0) > 0;
  const groups = useMemo(() => [...new Set(stations.map((station) => station.group_name))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [stations]);
  // 地图展示整组位置关系，不随状态筛选和搜索变化。
  const groupStations = useMemo(() => stations.filter((station) => station.group_name === group), [stations, group]);

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
              <Segmented label="筛选" value={filter} options={FILTERS} onValueChange={(value) => setFilter(value as Filter)} />
            </div>
            {group !== ALL_GROUPS && (
              <div className="mt-4">
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
