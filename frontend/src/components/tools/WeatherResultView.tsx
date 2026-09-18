import React from 'react';
import { CloudRain } from 'lucide-react';
import type { ToolResultProps } from './types';

export const WeatherResultView: React.FC<ToolResultProps> = ({ data }) => {
  if (!data?.current || !data?.rain_summary) return null;

  const loc = data.location || {};
  const cur = data.current || {};
  const rain = data.rain_summary || {};
  const wind = data.wind_summary || {};
  const hist = data.history?.daily || {};
  const fc = data.forecast?.daily || {};

  const histRain = new Map<string, number>();
  (hist.time || []).forEach((d: string, i: number) =>
    histRain.set(d, hist.precipitation_sum?.[i] ?? null)
  );
  const fcByDate = new Map<string, any>();
  (fc.time || []).forEach((d: string, i: number) =>
    fcByDate.set(d, {
      rain: fc.precipitation_sum?.[i],
      prob: fc.precipitation_probability_max?.[i],
      wind: fc.wind_speed_10m_max?.[i],
    })
  );
  const dates = [...new Set([...histRain.keys(), ...fcByDate.keys()])].sort();

  const cells: { label: string; value: string }[] = [
    {
      label: '最近 24 个完整小时降雨',
      value:
        rain.recent_24h_precipitation != null
          ? `${rain.recent_24h_precipitation} mm`
          : rain.recent_24h_window
          ? `数据不足（${rain.recent_24h_window.available_hours}/24 小时）`
          : '-',
    },
    {
      label: `历史合计降雨 (${data.query?.history_start_date || ''} ~ ${data.query?.history_end_date || ''})`,
      value: rain.history_total_precipitation != null ? `${rain.history_total_precipitation} mm` : '-',
    },
    {
      label: '历史最大日降雨',
      value: rain.history_max_daily_precipitation
        ? `${rain.history_max_daily_precipitation.date}: ${rain.history_max_daily_precipitation.value} mm`
        : '-',
    },
    {
      label: '预报合计降雨',
      value: rain.forecast_total_precipitation != null ? `${rain.forecast_total_precipitation} mm` : '-',
    },
    {
      label: '预报最大日降雨',
      value: rain.forecast_max_daily_precipitation
        ? `${rain.forecast_max_daily_precipitation.date}: ${rain.forecast_max_daily_precipitation.value} mm`
        : '-',
    },
    {
      label: '预报最大降水概率',
      value:
        rain.forecast_max_precipitation_probability != null
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
      <div className="text-[11px] text-neutral-400 px-0.5">
        位置: {loc.station_name ? `${loc.station_name} · ` : ''}
        ({loc.latitude}, {loc.longitude})
        {(data.query?.timezone || loc.timezone) && ` · 时区：${data.query?.timezone || loc.timezone}`}
      </div>
      {rain.recent_24h_window && (
        <div className="text-[11px] text-neutral-400 px-0.5">
          降雨统计窗口：{rain.recent_24h_window.start_time} 至 {rain.recent_24h_window.end_time}
          （天气服务小时数据）
        </div>
      )}
      <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm max-w-3xl">
        <div className="flex items-center gap-2 text-sm text-neutral-800 font-medium">
          <CloudRain className="w-4 h-4 text-neutral-500" />
          <span>{cur.condition ?? '-'}</span>
          <span className="text-neutral-500 font-normal">
            {cur.temperature_2m ?? '-'}℃（体感 {cur.apparent_temperature ?? '-'}℃，湿度{' '}
            {cur.relative_humidity_2m ?? '-'}%）
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2.5 max-h-64 overflow-y-auto overscroll-contain">
          {cells.map((c, i) => (
            <div
              key={i}
              className="px-2.5 py-2 bg-neutral-50 border border-neutral-100 rounded-md"
            >
              <div className="text-[10px] text-neutral-400">{c.label}</div>
              <div className="text-xs text-neutral-800 font-mono mt-0.5">{c.value}</div>
            </div>
          ))}
        </div>
      </div>
      {dates.length > 0 && (
        <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-sm">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">日期</th>
                <th className="py-2 px-3 whitespace-nowrap">历史降雨 (mm)</th>
                <th className="py-2 px-3 whitespace-nowrap">预报降雨 (mm)</th>
                <th className="py-2 px-3 whitespace-nowrap">降水概率 (%)</th>
                <th className="py-2 px-3 whitespace-nowrap">最大风速 (km/h)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800 font-mono text-[11px]">
              {dates.map((d: string) => (
                <tr key={d} className="hover:bg-neutral-50/70 transition-colors">
                  <td className="py-1 px-3 text-neutral-600 whitespace-nowrap">{d}</td>
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
