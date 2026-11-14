import { describe, expect, it } from 'vitest';
import { horizontalChange } from '@/features/monitoring/status';
import type { InspectionStation } from '@/services/api';

const station = (metrics: InspectionStation['metrics']): InspectionStation => ({
  station_uuid: 'uuid', station_name: '测试点 A', group_name: 'K3', screening: '建议调查',
  reasons: [], metrics, trend: [], previous_screening: null, last_conclusion: null, current: null,
});

describe('巡检结果里概括“动了多少”的数字', () => {
  it('与迷你曲线同一个量：水平变化大小，方向单独给出方位角', () => {
    // 北 -12、东 +5：水平 13 mm，方位约 157°（东南偏南）。
    const change = horizontalChange(station({ net_change_mm: { n: -12, e: 5, u: 6 } }));

    expect(change!.millimeters).toBeCloseTo(13);
    expect(change!.azimuth).toBeCloseTo(157.4, 1);
  });

  it('缺少北向或东向时不给数字', () => {
    expect(horizontalChange(station({}))).toBeNull();
    expect(horizontalChange(station({ net_change_mm: { n: 3 } }))).toBeNull();
  });
});
