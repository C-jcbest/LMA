import type { FC } from 'react';
import { ArrowUpIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MILLIMETER_DIGITS } from './format';
import { investigationStatusLabel } from './investigation';
import type { CurrentJudgment, InspectionStation } from '@/services/api';

// 一种状态一个颜色：警示只留给需人工复核；建议调查与持续关注是关注色；平稳是低饱和绿；数据问题是灰色。
const STATUS_DOT_CLASS: Record<string, string> = {
  需人工复核: 'bg-status-critical',
  建议调查: 'bg-status-attention',
  持续关注: 'bg-status-attention',
  未见明显变化: 'bg-status-normal',
};

export const StatusDot: FC<{ status: string | null | undefined; className?: string }> = ({ status, className }) => (
  <span
    aria-hidden
    className={cn('size-2 shrink-0 rounded-full', (status && STATUS_DOT_CLASS[status]) || 'bg-status-unknown', className)}
  />
);

const formatJudgmentDate = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
}).format(new Date(value)).replace('/', '-');

/** 当前判断的标签：状态后面跟来源与日期，用户能看出这是巡检粗筛还是调查结论、是哪天的。 */
export const JudgmentBadge: FC<{ judgment: CurrentJudgment; className?: string }> = ({ judgment, className }) => (
  <span className={cn('inline-flex min-w-0 items-center gap-2 text-xs', className)}>
    <StatusDot status={judgment.status} />
    <span className="font-medium text-foreground">{investigationStatusLabel(judgment.status)}</span>
    <span className="text-muted-foreground tabular-nums">
      · {judgment.at ? `${formatJudgmentDate(judgment.at)} ` : ''}{judgment.source}
    </span>
  </span>
);

/**
 * 巡检窗口内的水平变化：与行内迷你曲线画的是同一个量（水平位移大小），方向另用箭头表示，
 * 避免“曲线向上、数字为负”的误读。
 */
export function horizontalChange(station: Pick<InspectionStation, 'metrics'>): { millimeters: number; azimuth: number } | null {
  const north = station.metrics?.net_change_mm?.n;
  const east = station.metrics?.net_change_mm?.e;
  if (typeof north !== 'number' || typeof east !== 'number') {
    return null;
  }
  const millimeters = Math.hypot(north, east);
  const azimuth = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return { millimeters, azimuth };
}

/** 水平变化数值与方向箭头（北向上，顺时针）。 */
export const HorizontalChange: FC<{ change: { millimeters: number; azimuth: number }; className?: string }> = ({ change, className }) => (
  <span className={cn('inline-flex items-center gap-1 tabular-nums', className)} title={`水平位移方位约 ${Math.round(change.azimuth)}°（正北为 0°，顺时针）`}>
    <ArrowUpIcon aria-hidden className="size-3.5 text-muted-foreground" style={{ transform: `rotate(${change.azimuth}deg)` }} />
    {change.millimeters.toFixed(MILLIMETER_DIGITS)}
    <span className="text-muted-foreground text-xs font-normal">mm 水平</span>
  </span>
);

