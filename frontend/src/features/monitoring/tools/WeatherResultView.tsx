import React from 'react';
import {
  ChevronRightIcon,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from 'cn';
import type { WeatherArtifactData } from '@/types/envelope';
import { RainEvents } from '../RainEvents';
import { EmptyResultView } from './EmptyResultView';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const RainfallChart = React.lazy(() => import('./RainfallChart'));
const RAIN_CHART_HEIGHT = 140;

const ConditionIcon: React.FC<{ condition?: string | null }> = ({ condition }) => {
  const iconClass = 'size-4 shrink-0 text-muted-foreground';
  if (!condition) return <Cloud className={iconClass} aria-hidden />;
  if (condition.includes('雷')) return <CloudLightning className={iconClass} aria-hidden />;
  if (condition.includes('雪') || condition.includes('冻')) return <CloudSnow className={iconClass} aria-hidden />;
  if (condition.includes('雾') || condition.includes('霾')) return <CloudFog className={iconClass} aria-hidden />;
  if (condition.includes('雨') || condition.includes('阵')) return <CloudRain className={iconClass} aria-hidden />;
  if (condition.includes('多云') || condition.includes('少云')) return <CloudSun className={iconClass} aria-hidden />;
  if (condition.includes('阴')) return <Cloud className={iconClass} aria-hidden />;
  if (condition.includes('晴')) return <Sun className={iconClass} aria-hidden />;
  return <Cloud className={iconClass} aria-hidden />;
};

const DetailTable: React.FC<{ summary: string; children: React.ReactNode }> = ({ summary, children }) => (
  <Collapsible className="rounded-lg border">
    <CollapsibleTrigger className="group/detail flex min-h-9 w-full items-center gap-2 px-3 text-start text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]/detail:rotate-90" aria-hidden />
      <span>{summary}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="max-h-72 overflow-auto border-t">{children}</CollapsibleContent>
  </Collapsible>
);

export const WeatherResultView: React.FC<{ data: WeatherArtifactData; onAsk?: (date: string) => void; askDisabled?: boolean }> = ({ data, onAsk, askDisabled }) => {
  const loc = data.location || {};
  const cur = data.current || {};
  const rain = data.rain_summary;
  const wind = data.wind_summary || {};
  const hist = data.history?.daily;
  const hourly = data.history?.hourly;
  const fc = data.forecast?.daily;
  const hasForecast = Boolean(fc?.time?.length);
  const hasWeatherData = Boolean(
    data.current ||
      hist?.time?.length ||
      hourly?.time?.length ||
      fc?.time?.length ||
      rain?.recent_24h_window?.available_hours ||
      rain?.history_total_precipitation != null ||
      rain?.forecast_total_precipitation != null ||
      Object.values(wind).some((value) => value != null),
  );
  if (!hasWeatherData) {
    return <EmptyResultView>该位置和时间范围内暂无天气数据</EmptyResultView>;
  }

  const histRain = new Map<string, number | null>();
  (hist?.time || []).forEach((d: string, i: number) =>
    histRain.set(d, hist?.precipitation_sum?.[i] ?? null)
  );
  const fcByDate = new Map<
    string,
    { rain?: number | null; prob?: number | null; wind?: number | null }
  >();
  (fc?.time || []).forEach((d: string, i: number) =>
    fcByDate.set(d, {
      rain: fc?.precipitation_sum?.[i],
      prob: fc?.precipitation_probability_max?.[i],
      wind: fc?.wind_speed_10m_max?.[i],
    })
  );
  const dates = [...new Set([...histRain.keys(), ...fcByDate.keys()])].sort();

  const rainCells: { label: string; value: string; detail?: string; forecast?: boolean }[] = [
    {
      label: '期间合计',
      value: rain?.history_total_precipitation != null ? `${rain.history_total_precipitation} mm` : '-',
    },
    {
      label: '最大日降雨',
      value: rain?.history_max_daily_precipitation
        ? `${rain.history_max_daily_precipitation.value} mm · ${rain.history_max_daily_precipitation.date.slice(5)}`
        : '-',
    },
    {
      label: '最近 24 小时',
      value:
        rain?.recent_24h_precipitation != null
          ? `${rain.recent_24h_precipitation} mm`
          : rain?.recent_24h_window
          ? `仅覆盖 ${rain.recent_24h_window.available_hours}/24 小时`
          : '-',
      detail: rain?.recent_24h_window
        ? `${rain.recent_24h_window.start_time} 至 ${rain.recent_24h_window.end_time}`
        : undefined,
    },
    {
      forecast: true,
      label: '预报合计',
      value: rain?.forecast_total_precipitation != null ? `${rain.forecast_total_precipitation} mm` : '-',
    },
    {
      forecast: true,
      label: '预报最大日',
      value: rain?.forecast_max_daily_precipitation
        ? `${rain.forecast_max_daily_precipitation.value} mm · ${rain.forecast_max_daily_precipitation.date.slice(5)}`
        : '-',
    },
    {
      forecast: true,
      label: '预报最大降水概率',
      value:
        rain?.forecast_max_precipitation_probability != null
          ? `${rain.forecast_max_precipitation_probability}%`
          : '-',
    },
  ];
  const windCells: { label: string; value: string; forecast?: boolean }[] = [
    {
      label: '当前风速 / 阵风',
      value:
        wind.current_wind_speed != null
          ? `${wind.current_wind_speed} / ${wind.current_wind_gust ?? '-'} km/h`
          : '-',
    },
    {
      label: '期间最大风速 / 阵风',
      value:
        wind.history_max_wind_speed != null
          ? `${wind.history_max_wind_speed} / ${wind.history_max_wind_gust ?? '-'} km/h`
          : '-',
    },
    {
      forecast: true,
      label: '预报最大风速 / 阵风',
      value:
        wind.forecast_max_wind_speed != null
          ? `${wind.forecast_max_wind_speed} / ${wind.forecast_max_wind_gust ?? '-'} km/h`
          : '-',
    },
  ];

  const isShown = (cell: { value: string; forecast?: boolean }) => cell.value !== '-' && (hasForecast || !cell.forecast);
  const visibleRainCells = rainCells.filter(isShown);
  const visibleWindCells = windCells.filter(isShown);
  const dailyRain = dates.map((date) => {
    const history = histRain.get(date);
    if (histRain.has(date)) {
      return { date, value: history ?? null, isForecast: false };
    }
    const forecast = fcByDate.get(date)?.rain;
    return { date, value: typeof forecast === 'number' ? forecast : null, isForecast: true };
  });

  return (
    <div className="space-y-4">
      {!loc.station_name && (
        <p className="text-xs text-muted-foreground tabular-nums">{loc.latitude}, {loc.longitude}</p>
      )}
      {dailyRain.length > 0 && (
        <React.Suspense fallback={<Skeleton className="w-full" style={{ height: RAIN_CHART_HEIGHT }} />}>
          <RainfallChart days={dailyRain} height={RAIN_CHART_HEIGHT} askDisabled={askDisabled} onAsk={onAsk && (({ date }) => onAsk(date))} />
        </React.Suspense>
      )}
      {data.rain_events && (
        <RainEvents
          events={data.rain_events}
          daily={(hist?.time ?? []).map((date, index) => ({ date, value: hist?.precipitation_sum?.[index] ?? null }))}
          thresholdMm={data.rain_threshold_mm ?? 25}
        />
      )}
      {visibleRainCells.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-3">
          {visibleRainCells.map((cell) => (
            <div key={cell.label} className="min-w-0" title={cell.detail}>
              <dt className="text-xs text-muted-foreground">{cell.label}</dt>
              <dd className="text-base font-medium tabular-nums wrap-break-word">{cell.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.current && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ConditionIcon condition={cur.condition} />
          <span className="font-medium">{cur.condition ?? '—'}</span>
          <span className="text-muted-foreground tabular-nums">
            {cur.temperature_2m ?? '—'}℃ · 体感 {cur.apparent_temperature ?? '—'}℃ · 湿度 {cur.relative_humidity_2m ?? '—'}%
          </span>
        </div>
      )}
      {dates.length > 0 && (
        <DetailTable summary={`逐日明细（${dates.length} 天）`}>
          <Table containerClassName="overflow-visible" className={cn('text-xs', hasForecast && 'min-w-136')}>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>历史降雨 (mm)</TableHead>
                {hasForecast && <TableHead>预报降雨 (mm)</TableHead>}
                {hasForecast && <TableHead>降水概率 (%)</TableHead>}
                {hasForecast && <TableHead>最大风速 (km/h)</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dates.map((date) => (
                <TableRow key={date}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{date}</TableCell>
                  <TableCell>{histRain.get(date) ?? '—'}</TableCell>
                  {hasForecast && <TableCell>{fcByDate.get(date)?.rain ?? '—'}</TableCell>}
                  {hasForecast && <TableCell>{fcByDate.get(date)?.prob ?? '—'}</TableCell>}
                  {hasForecast && <TableCell>{fcByDate.get(date)?.wind ?? '—'}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailTable>
      )}
      {hourly && hourly.time.length > 0 && (
        <DetailTable summary={`逐小时降水（${hourly.time.length} 小时）`}>
          <Table containerClassName="overflow-visible" className="text-xs">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>时间（该时刻前一小时）</TableHead>
                <TableHead>降水 (mm)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hourly.time.map((time, index) => (
                <TableRow key={time}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{time.replace('T', ' ')}</TableCell>
                  <TableCell>{hourly.precipitation[index] ?? '缺测'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailTable>
      )}
      {visibleWindCells.length > 0 && (
        <DetailTable summary="风况">
          <dl className="grid gap-x-6 gap-y-2 p-3 text-sm sm:grid-cols-2">
            {visibleWindCells.map((cell) => (
              <div key={cell.label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{cell.label}</dt>
                <dd className="font-medium tabular-nums">{cell.value}</dd>
              </div>
            ))}
          </dl>
        </DetailTable>
      )}
    </div>
  );
};
