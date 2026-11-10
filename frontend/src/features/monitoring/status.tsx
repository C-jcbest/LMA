import type { FC } from 'react';
import { cn } from '@/lib/utils';
import type { InspectionStation } from '@/services/api';

// 巡检初筛和调查结论共用一套颜色：红色只留给已调查并需要人工复核的测点。
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

const AXIS_LABELS = { n: '北向', e: '东向', u: '垂向' } as const;

/** 巡检窗口内变化最大的方向，用一个数字概括“动了多少”。 */
export function largestChange(station: Pick<InspectionStation, 'metrics'>): { axis: string; millimeters: number } | null {
  const changes = station.metrics?.net_change_mm;
  if (!changes) {
    return null;
  }
  let largest: { axis: string; millimeters: number } | null = null;
  for (const axis of ['n', 'e', 'u'] as const) {
    const millimeters = changes[axis];
    if (typeof millimeters !== 'number') {
      continue;
    }
    if (largest === null || Math.abs(millimeters) > Math.abs(largest.millimeters)) {
      largest = { axis: AXIS_LABELS[axis], millimeters };
    }
  }
  return largest;
}

export const formatMillimeters = (millimeters: number) =>
  `${millimeters > 0 ? '+' : ''}${millimeters.toFixed(1)}`;
