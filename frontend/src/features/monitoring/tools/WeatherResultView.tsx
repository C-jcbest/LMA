import React from 'react';
import { CloudRain } from 'lucide-react';
import type { WeatherArtifactData } from '@/types/envelope';
import { EmptyResultView } from './EmptyResultView';

interface DailyRain {
  date: string;
  value: number | null;
  isForecast: boolean;
}

const BAR_AREA_HEIGHT = 64;

/** 逐日降雨一眼看出集中在哪几天；精确数值在悬停提示和下方明细里。 */
const DailyRainBars: React.FC<{ days: readonly DailyRain[] }> = ({ days }) => {
  const largest = Math.max(0, ...days.map((day) => day.value ?? 0));
  const hasForecast = days.some((day) => day.isForecast);
  return (
    <figure className="space-y-1">
      <div role="img" aria-label="逐日降雨柱状图" className="flex items-end gap-px border-b" style={{ height: BAR_AREA_HEIGHT }}>
        {days.map((day) => {
          const height = largest > 0 && day.value ? Math.max(2, (day.value / largest) * BAR_AREA_HEIGHT) : 0;
          return (
            <div key={day.date} className="flex h-full min-w-0 flex-1 items-end" title={`${day.date} ${day.value ?? '缺测'} mm${day.isForecast ? '（预报）' : ''}`}>
              <div className="w-full rounded-t-[1px] bg-chart-rain" style={{ height, opacity: day.isForecast ? 0.45 : 1 }} />
            </div>
          );
        })}
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{days[0]!.date.slice(5)}</span>
        <span>日降雨，最大 {largest} mm{hasForecast ? ' · 浅色为预报' : ''}</span>
        <span>{days[days.length - 1]!.date.slice(5)}</span>
      </figcaption>
    </figure>
  );
};

const DetailTable: React.FC<{ summary: string; children: React.ReactNode }> = ({ summary, children }) => (
  <details className="group rounded-lg border">
    <summary className="flex min-h-9 cursor-pointer items-center px-3 text-xs text-muted-foreground hover:text-foreground">
      {summary}
    </summary>
    <div className="max-h-72 overflow-auto border-t">{children}</div>
  </details>
);

export const WeatherResultView: React.FC<{ data: WeatherArtifactData }> = ({ data }) => {
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

  // 只查历史时没有预报；预报类条目整组省略，避免一排“-”。
  const cells: { label: string; value: string; forecast?: boolean }[] = [
    {
      label: '最近 24 个完整小时降雨',
      value:
        rain?.recent_24h_precipitation != null
          ? `${rain.recent_24h_precipitation} mm`
          : rain?.recent_24h_window
          ? `现有记录覆盖 ${rain.recent_24h_window.available_hours}/24 小时`
          : '-',
    },
    {
      label: `历史合计降雨 (${data.query?.history_start_date || ''} ~ ${data.query?.history_end_date || ''})`,
      value: rain?.history_total_precipitation != null ? `${rain.history_total_precipitation} mm` : '-',
    },
    {
      label: '历史最大日降雨',
      value: rain?.history_max_daily_precipitation
        ? `${rain.history_max_daily_precipitation.date}: ${rain.history_max_daily_precipitation.value} mm`
        : '-',
    },
    {
      forecast: true,
      label: '预报合计降雨',
      value: rain?.forecast_total_precipitation != null ? `${rain.forecast_total_precipitation} mm` : '-',
    },
    {
      forecast: true,
      label: '预报最大日降雨',
      value: rain?.forecast_max_daily_precipitation
        ? `${rain.forecast_max_daily_precipitation.date}: ${rain.forecast_max_daily_precipitation.value} mm`
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
    {
      label: '当前风速 / 阵风',
      value:
        wind.current_wind_speed != null
          ? `${wind.current_wind_speed} / ${wind.current_wind_gust ?? '-'} km/h`
          : '-',
    },
    {
      label: '历史最大风速 / 阵风',
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

  const visibleCells = cells.filter((cell) => cell.value !== '-' && (hasForecast || !cell.forecast));
  const dailyRain = dates.map((date) => {
    const history = histRain.get(date);
    if (typeof history === 'number') {
      return { date, value: history, isForecast: false };
    }
    const forecast = fcByDate.get(date)?.rain;
    return { date, value: typeof forecast === 'number' ? forecast : null, isForecast: true };
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-xs text-muted-foreground wrap-break-word">
        <p>
          {loc.station_name ? `${loc.station_name} · ` : ''}({loc.latitude}, {loc.longitude})
          {(data.query?.timezone || loc.timezone) && ` · ${data.query?.timezone || loc.timezone}`}
        </p>
        {rain?.recent_24h_window && (
          <p>最近 24 小时统计：{rain.recent_24h_window.start_time} 至 {rain.recent_24h_window.end_time}</p>
        )}
      </div>
      {data.current && (
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <CloudRain className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>{cur.condition ?? '-'}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {cur.temperature_2m ?? '-'}℃（体感 {cur.apparent_temperature ?? '-'}℃，湿度 {cur.relative_humidity_2m ?? '-'}%）
          </span>
        </div>
      )}
      {visibleCells.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-3">
          {visibleCells.map((cell) => (
            <div key={cell.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground wrap-break-word">{cell.label}</dt>
              <dd className="text-sm font-medium tabular-nums wrap-break-word">{cell.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {dailyRain.length > 1 && <DailyRainBars days={dailyRain} />}
      {dates.length > 0 && (
        <DetailTable summary={`逐日明细（${dates.length} 天）`}>
          <table className={`${hasForecast ? 'min-w-[34rem]' : ''} w-full border-collapse text-left text-xs`}>
            <thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal whitespace-nowrap">日期</th>
                <th className="px-3 py-2 font-normal whitespace-nowrap">历史降雨 (mm)</th>
                {hasForecast && <th className="px-3 py-2 font-normal whitespace-nowrap">预报降雨 (mm)</th>}
                {hasForecast && <th className="px-3 py-2 font-normal whitespace-nowrap">降水概率 (%)</th>}
                {hasForecast && <th className="px-3 py-2 font-normal whitespace-nowrap">最大风速 (km/h)</th>}
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {dates.map((date) => (
                <tr key={date}>
                  <td className="px-3 py-1 whitespace-nowrap text-muted-foreground">{date}</td>
                  <td className="px-3 py-1">{histRain.get(date) ?? '-'}</td>
                  {hasForecast && <td className="px-3 py-1">{fcByDate.get(date)?.rain ?? '-'}</td>}
                  {hasForecast && <td className="px-3 py-1">{fcByDate.get(date)?.prob ?? '-'}</td>}
                  {hasForecast && <td className="px-3 py-1">{fcByDate.get(date)?.wind ?? '-'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </DetailTable>
      )}
      {hourly && hourly.time.length > 0 && (
        <DetailTable summary={`逐小时降水（${hourly.time.length} 小时）`}>
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal whitespace-nowrap">时间（该时刻前一小时）</th>
                <th className="px-3 py-2 font-normal whitespace-nowrap">降水 (mm)</th>
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {hourly.time.map((time, index) => (
                <tr key={time}>
                  <td className="px-3 py-1 whitespace-nowrap text-muted-foreground">{time.replace('T', ' ')}</td>
                  <td className="px-3 py-1">{hourly.precipitation[index] ?? '缺测'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailTable>
      )}
    </div>
  );
};
