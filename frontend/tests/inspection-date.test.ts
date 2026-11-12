import { describe, expect, it } from 'vitest';
import { isInspectionFromToday } from '@/features/today/inspection-date';

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
});
