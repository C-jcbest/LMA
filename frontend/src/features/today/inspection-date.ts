const businessDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function isInspectionFromToday(finishedAt: string, now: number): boolean {
  const finished = new Date(finishedAt);
  return Number.isFinite(finished.getTime()) && businessDate.format(finished) === businessDate.format(now);
}
