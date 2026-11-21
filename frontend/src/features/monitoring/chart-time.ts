const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});

/** 平台未附偏移的时间戳以北京时间记录。 */
export function chartMillis(value: string): number {
  const iso = value.length === 10 ? value + 'T00:00:00' : value.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + '+08:00');
}

export const chartClock = (millis: number) => clock.format(millis);

export function chartDay(millis: number) {
  const start = chartMillis(chartClock(millis).slice(0, 10) + 'T00:00:00');
  return { start, end: start + 86400e3 };
}

export function rainfallDays(start: number, end: number) {
  return { start: chartDay(start).start, end: chartDay(Math.max(start, end - 1)).end };
}
