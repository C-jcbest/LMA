import { describe, expect, it } from 'vitest';
import { askTargetsOfMessage, formatAskRange, toAskTargetRecords } from '@/features/monitoring/ask-targets';

const at = (text: string) => new Date(text).getTime();

describe('追问对象', () => {
  it('整日范围只写日期，结束日按包含计', () => {
    expect(formatAskRange(at('2026-10-27T00:00'), at('2026-10-28T00:00'))).toBe('10月27日');
    expect(formatAskRange(at('2026-10-27T00:00'), at('2026-10-30T00:00'))).toBe('10月27日–10月29日');
  });

  it('非整日范围写到分钟，同一天不重复日期', () => {
    expect(formatAskRange(at('2026-10-27T08:30'), at('2026-10-27T12:00'))).toBe('10月27日 08:30–12:00');
    expect(formatAskRange(at('2026-10-27T08:30'), at('2026-10-29T06:00'))).toBe('10月27日 08:30–10月29日 06:00');
  });

  it('提交与回读保持同一时间段', () => {
    const target = { stationUuid: 'a', stationName: '测试点 A', start: at('2026-10-27T08:30'), end: at('2026-10-29T06:00') };
    const records = toAskTargetRecords([target]);
    expect(askTargetsOfMessage({ ask_targets: records })).toEqual([target]);
    expect(askTargetsOfMessage({})).toEqual([]);
  });
});
