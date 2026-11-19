import type { FC } from 'react';
import type { RainEvent } from '@/types/envelope';
import { formatSigned, RATE_DIGITS } from './format';

const MAX_RAIN_EVENTS = 3;

const formatEventDays = (event: RainEvent) => (
  event.start === event.end ? event.start.slice(5) : `${event.start.slice(5)} 至 ${event.end.slice(5)}`
);

const formatRate = (rate: number | null) => (rate === null ? '—' : formatSigned(rate, RATE_DIGITS));

/**
 * 强降雨过程：只陈述过程雨量与主方向前后速率，不判断因果；没有过程时给一行最大日降雨。
 * 测点页与天气依据共用，数值都来自服务端 app/rainfall.py。
 */
export const RainEvents: FC<{
  events: readonly RainEvent[];
  daily: ReadonlyArray<{ date: string; value: number | null }>;
  thresholdMm: number;
}> = ({ events, daily, thresholdMm }) => {
  const shown = [...events].sort((a, b) => b.total_mm - a.total_mm).slice(0, MAX_RAIN_EVENTS)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (shown.length === 0) {
    const wettest = daily.reduce<{ date: string; value: number } | null>((best, day) => (
      day.value !== null && (best === null || day.value > best.value) ? { date: day.date, value: day.value } : best
    ), null);
    return (
      <p className="text-muted-foreground text-sm tabular-nums">
        {wettest && wettest.value > 0 ? `无日降雨 ≥ ${thresholdMm} mm 的过程，最大 ${wettest.value} mm（${wettest.date.slice(5)}）` : '期间无降雨'}
      </p>
    );
  }
  return (
    <ul aria-label="强降雨过程" className="space-y-1 text-sm">
      {shown.map((event) => (
        <li key={event.start} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 tabular-nums">
          <span className="font-medium">{formatEventDays(event)}</span>
          <span>
            {event.total_mm} mm
            {event.antecedent_7d_mm !== null && <span className="text-muted-foreground">（前 7 天 {event.antecedent_7d_mm} mm）</span>}
          </span>
          {event.axis_name && (
            <span className="text-muted-foreground">
              {event.axis_name}速率 <span className="text-foreground">{formatRate(event.rate_before_mm_day)} → {formatRate(event.rate_after_mm_day)}</span> mm/天
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};
