import React from 'react';
import { CloudRain } from 'lucide-react';
import type { WeatherArtifactData } from '@/types/envelope';
import { EmptyResultView } from './EmptyResultView';

export const WeatherResultView: React.FC<{ data: WeatherArtifactData }> = ({ data }) => {
  const loc = data.location || {};
  const cur = data.current || {};
  const rain = data.rain_summary;
  const wind = data.wind_summary || {};
  const hist = data.history?.daily;
  const fc = data.forecast?.daily;
  const hasWeatherData = Boolean(
    data.current ||
      hist?.time?.length ||
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

  const cells: { label: string; value: string }[] = [
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
      label: '预报合计降雨',
      value: rain?.forecast_total_precipitation != null ? `${rain.forecast_total_precipitation} mm` : '-',
    },
    {
      label: '预报最大日降雨',
      value: rain?.forecast_max_daily_precipitation
        ? `${rain.forecast_max_daily_precipitation.date}: ${rain.forecast_max_daily_precipitation.value} mm`
        : '-',
    },
    {
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
      label: '预报最大风速 / 阵风',
      value:
        wind.forecast_max_wind_speed != null
          ? `${wind.forecast_max_wind_speed} / ${wind.forecast_max_wind_gust ?? '-'} km/h`
          : '-',
    },
  ];

  return (
    <div className="space-y-1.5">
      <div className="text-sm text-muted-foreground wrap-break-word">
        位置: {loc.station_name ? `${loc.station_name} · ` : ''}
        ({loc.latitude}, {loc.longitude})
        {(data.query?.timezone || loc.timezone) && ` · 时区：${data.query?.timezone || loc.timezone}`}
      </div>
      {rain?.recent_24h_window && (
        <div className="text-sm text-muted-foreground wrap-break-word">
          降雨统计窗口：{rain.recent_24h_window.start_time} 至 {rain.recent_24h_window.end_time}
          （天气服务小时数据）
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground font-medium pt-1">
        <CloudRain className="w-4 h-4 text-muted-foreground shrink-0" />
        <span>{cur.condition ?? '-'}</span>
        <span className="text-muted-foreground font-normal text-xs">
          {cur.temperature_2m ?? '-'}℃（体感 {cur.apparent_temperature ?? '-'}℃，湿度{' '}
          {cur.relative_humidity_2m ?? '-'}%）
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 min-[480px]:grid-cols-2">
        {cells.map((c, i) => (
          <div key={i} className="flex flex-col gap-0.5 min-w-0">
            <dt className="text-sm text-muted-foreground wrap-break-word">{c.label}</dt>
            <dd className="text-foreground text-sm wrap-break-word">{c.value}</dd>
          </div>
        ))}
      </dl>
      {dates.length > 0 && (
        <div className="border border-border/60 rounded-lg bg-background/60 overflow-x-auto">
          <table className="min-w-[34rem] w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-muted/40 text-muted-foreground font-medium border-b border-border/60">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">日期</th>
                <th className="py-2 px-3 whitespace-nowrap">历史降雨 (mm)</th>
                <th className="py-2 px-3 whitespace-nowrap">预报降雨 (mm)</th>
                <th className="py-2 px-3 whitespace-nowrap">降水概率 (%)</th>
                <th className="py-2 px-3 whitespace-nowrap">最大风速 (km/h)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 text-foreground text-xs">
              {dates.map((d: string) => (
                <tr key={d} className="hover:bg-muted/50 transition-colors">
                  <td className="py-1 px-3 text-muted-foreground whitespace-nowrap">{d}</td>
                  <td className="py-1 px-3">{histRain.get(d) ?? '-'}</td>
                  <td className="py-1 px-3">{fcByDate.get(d)?.rain ?? '-'}</td>
                  <td className="py-1 px-3">{fcByDate.get(d)?.prob ?? '-'}</td>
                  <td className="py-1 px-3">{fcByDate.get(d)?.wind ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
