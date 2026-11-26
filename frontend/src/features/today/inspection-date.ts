const businessDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const monthDayTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const DAY_MS = 86_400_000;

export function isInspectionFromToday(finishedAt: string, now: number): boolean {
  const finished = new Date(finishedAt);
  return Number.isFinite(finished.getTime()) && businessDate.format(finished) === businessDate.format(now);
}

export function formatInspectionRecency(finishedAt: string, now: number): string {
  const finished = new Date(finishedAt);
  if (!Number.isFinite(finished.getTime())) {
    return finishedAt;
  }
  const finishedDay = businessDate.format(finished);
  const currentDay = businessDate.format(now);
  if (finishedDay === currentDay) {
    return `今天 ${timeOnly.format(finished)} 巡检`;
  }
  const dayDiff = Math.round(
    (Date.parse(`${currentDay}T00:00:00+08:00`) - Date.parse(`${finishedDay}T00:00:00+08:00`)) / DAY_MS,
  );
  if (dayDiff === 1) {
    return `昨天 ${timeOnly.format(finished)} 巡检`;
  }
  if (dayDiff > 1 && dayDiff < 365) {
    return `${dayDiff} 天前 · ${monthDayTime.format(finished)}`;
  }
  return `上次巡检 ${finishedDay} ${timeOnly.format(finished)}`;
}
