import { describe, expect, it } from 'vitest';
import { formatMillimeters, largestChange } from '@/features/monitoring/status';
import type { InspectionStation } from '@/services/api';

const station = (metrics: InspectionStation['metrics']): InspectionStation => ({
  station_uuid: 'uuid', station_name: '测试点 A', group_name: 'K3', screening: '建议调查',
  reasons: [], metrics, trend: [], previous_screening: null, last_conclusion: null,
});

describe('巡检结果里概括“动了多少”的数字', () => {
  it('取净变化绝对值最大的方向并保留正负号', () => {
    const change = largestChange(station({ net_change_mm: { n: 2.1, e: -11.9, u: 6 } }));

    expect(change).toEqual({ axis: '东向', millimeters: -11.9 });
    expect(formatMillimeters(change!.millimeters)).toBe('-11.9');
    expect(formatMillimeters(6)).toBe('+6.0');
  });

  it('数据不足的测点没有净变化时不给数字', () => {
    expect(largestChange(station({}))).toBeNull();
    expect(largestChange(station({ net_change_mm: {} }))).toBeNull();
  });
});
