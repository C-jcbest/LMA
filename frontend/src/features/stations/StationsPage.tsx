import { useMemo, useState, type FC } from 'react';
import { useNavigation } from '@/app/navigation';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { useInspection } from '@/features/inspection/InspectionContext';
import { investigationStatusLabel } from '@/features/monitoring/investigation';
import { formatMillimeters, largestChange, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import type { InspectionStation, Screening } from '@/services/api';

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

const matchesFilter = (station: InspectionStation, filter: Filter) => {
  if (filter === 'attention') {
    return station.screening === '建议调查';
  }
  if (filter === 'unavailable') {
    return station.screening === '数据不足' || station.screening === '暂无法分析';
  }
  return true;
};

const StationRow: FC<{ station: InspectionStation }> = ({ station }) => {
  const { openStation } = useNavigation();
  const change = largestChange(station);
  const isAttention = station.screening === '建议调查';

  return (
    <li>
      <button
        type="button"
        onClick={() => openStation(station.station_uuid)}
        className="station-row hover:bg-muted/60 focus-visible:ring-ring w-full rounded-lg text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot status={station.screening} />
          <span className="min-w-0 truncate font-medium">{station.station_name}</span>
          <span className="text-muted-foreground shrink-0 text-xs">{station.group_name}</span>
        </span>
        <span className="station-row-trend"><TrendLine values={station.trend} emphasized={isAttention} className="h-7" /></span>
        <span className="station-row-note text-muted-foreground min-w-0 truncate text-sm">
          {station.reasons[0] ?? investigationStatusLabel(station.screening)}
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
  const { latest, isLoading, hasLoadError, reload } = useInspection();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const stations = latest?.stations;
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
        SCREENING_ORDER[a.screening] - SCREENING_ORDER[b.screening]
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
            <button type="button" disabled={isLoading} className="ms-1 underline underline-offset-4 disabled:opacity-50" onClick={reload}>重试</button>
          </p>
        )}
        {!hasStations && !isLoading && !hasLoadError && (
          <p className="text-muted-foreground mt-4 text-sm">还没有巡检结果。回到今日页开始一次巡检后，这里会列出全部测点。</p>
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
