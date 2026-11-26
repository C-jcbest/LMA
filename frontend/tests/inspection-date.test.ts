import { describe, expect, it } from 'vitest';
import { formatInspectionRecency, isInspectionFromToday } from '@/features/today/inspection-date';

describe('巡检日期使用上海时区', () => {
  it('上海午夜前后的结果不能视为同一天', () => {
    const now = Date.parse('2026-11-13T16:01:00Z');
    expect(isInspectionFromToday('2026-11-13T15:59:00Z', now)).toBe(false);
    expect(isInspectionFromToday('2026-11-13T16:00:00Z', now)).toBe(true);
  });
  it('不同年份和无效日期不是当天', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    expect(isInspectionFromToday('2025-11-13T00:00:00Z', now)).toBe(false);
    expect(isInspectionFromToday('invalid', now)).toBe(false);
  });
  it('相对巡检时间按上海时区区分今天、昨天与多天前', () => {
    const now = Date.parse('2026-11-26T10:00:00+08:00');
    expect(formatInspectionRecency('2026-11-26T08:30:00+08:00', now)).toBe('今天 08:30 巡检');
    expect(formatInspectionRecency('2026-11-25T15:14:00+08:00', now)).toBe('昨天 15:14 巡检');
    expect(formatInspectionRecency('2026-11-21T15:14:00+08:00', now)).toBe('5 天前 · 11/21 15:14');
  });
});
