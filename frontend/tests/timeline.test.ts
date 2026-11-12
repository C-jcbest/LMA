import { describe, expect, it } from 'vitest';
import {
  buildTimelineOption,
  dailyRainfallWithin,
  displacementBasisLabel,
  displacementOf,
  latestHorizontal,
  peerSeriesFor,
  toDisplacement,
  type ChartColors,
} from '../src/features/monitoring/timeline';
import type { GnssArtifactData, WeatherArtifactData } from '../src/types/envelope';

const colors = new Proxy({}, { get: (_, key) => String(key) }) as ChartColors;

const series = (fields: Partial<GnssArtifactData> = {}): GnssArtifactData => ({
  station_name: '测试点 A',
  begin_time: '2026-11-01 00:00:00',
  end_time: '2026-11-11 00:00:00',
  timezone: 'Asia/Shanghai',
  total_points: 3,
  returned_points: 3,
  downsampled: false,
  points: [
    { time: '2026-11-01 00:00:00', n: 100, e: 200, u: 300 },
    { time: '2026-11-02 00:00:00', n: null, e: 200.003, u: 300.001 },
    { time: '2026-11-03 00:00:00', n: 100.004, e: 200.003, u: 300.002 },
  ],
  summary: { n: { count: 2 }, e: { count: 3 }, u: { count: 3 }, gaps: [{ from: '2026-11-01 12:00:00', to: '2026-11-02 12:00:00', missing_hours: 24 }] },
  ...fields,
});

const weather = (fields: Partial<WeatherArtifactData>): WeatherArtifactData => ({
  ok: true,
  location: { latitude: 30, longitude: 103 },
  query: { timezone: 'Asia/Shanghai', history_start_date: '2026-11-01', history_end_date: '2026-11-08', forecast_days: 3 },
  ...fields,
});

describe('测点时间轴数据', () => {
  it('有固定参考时曲线是累计位移，不以窗口首点归零', () => {
    const data = series({ reference: { coordinates_m: { n: 99.99, e: 200, u: 300 } } });
    expect(displacementBasisLabel(data)).toBe('相对固定参考的累计位移');
    const points = displacementOf(data);
    expect(points.map((point) => point.n)).toEqual([10, null, 14]);
    expect(latestHorizontal(data)).toEqual({ north: 14, east: 3 });
  });

  it('平台未登记固定参考时说明并退回本窗口首点', () => {
    expect(displacementBasisLabel(series())).toBe('平台未登记固定参考，相对本窗口首点');
    expect(displacementBasisLabel(series({ reference: { coordinates_m: { n: 100, e: null, u: null } } })))
      .toContain('部分方向');
  });

  it('无参考时位移相对窗口首个有效点换算为毫米，缺测不转换为零', () => {
    const points = toDisplacement(series().points);
    expect(points[0]).toMatchObject({ n: 0, e: 0, u: 0, h: 0 });
    expect(points[1]).toMatchObject({ n: null, e: 3, h: null });
    expect(points[2]).toMatchObject({ n: 4, e: 3, h: 5 });
  });

  it('首点缺测时以该方向第一个有效值为基准', () => {
    const points = toDisplacement([
      { time: 't1', n: null, e: 1, u: 1 },
      { time: 't2', n: 5, e: 1, u: 1 },
      { time: 't3', n: 5.002, e: 1, u: 1 },
    ]);
    expect(points.map((point) => point.n)).toEqual([null, 0, 2]);
  });

  it('降雨只取窗口内日期，同一天历史优先于预报', () => {
    const rainfall = dailyRainfallWithin(
      [weather({
        history: { daily: { time: ['2026-10-31', '2026-11-02'], precipitation_sum: [9, 7] } },
        forecast: { daily: { time: ['2026-11-02', '2026-11-03'], precipitation_sum: [1, 2] } },
      })],
      '2026-11-01 00:00:00',
      '2026-11-05 00:00:00',
    );
    expect(rainfall).toEqual([
      { date: '2026-11-02', value: 7, isForecast: false },
      { date: '2026-11-03', value: 2, isForecast: true },
    ]);
  });

  it('同组对比忽略重叠不足的序列，并在共同窗口内重新取首点', () => {
    const peers = peerSeriesFor(series(), [
      {
        name: '测试点 B',
        series: [series({
          begin_time: '2026-10-20 00:00:00',
          end_time: '2026-11-11 00:00:00',
          points: [
            { time: '2026-10-25 00:00:00', n: 1, e: 1, u: 1 },
            { time: '2026-11-01 00:00:00', n: 2, e: 2, u: 2 },
            { time: '2026-11-02 00:00:00', n: 2.003, e: 2.004, u: 2 },
          ],
        })],
      },
      {
        name: '测试点 C',
        series: [series({ begin_time: '2026-11-09 00:00:00', end_time: '2026-11-11 00:00:00' })],
      },
    ]);
    expect(peers.map((peer) => peer.name)).toEqual(['测试点 B']);
    expect(peers[0]!.points.map((point) => point.h)).toEqual([0, 5]);
  });

  it('有降雨时位移与降雨共用时间轴，日降雨覆盖整天，缩放同时作用于两者', () => {
    const option = buildTimelineOption({
      data: series(),
      rainfall: [{ date: '2026-11-02', value: 7, isForecast: false }],
      peers: [],
      mode: 'components',
    }, colors) as Record<string, any>;

    expect(option.grid).toHaveLength(2);
    expect(option.dataZoom[0].xAxisIndex).toEqual([0, 1]);
    expect(option.axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
    const names = option.series.map((item: { name: string }) => item.name);
    expect(names).toEqual(['证据区间', '北向 N', '东向 E', '垂直 U', '日降雨']);
    const bands = option.series[0].markArea.data.map((band: Array<{ name?: string }>) => band[0]!.name);
    expect(bands).toEqual(['缺测']);
    expect(option.series[1].connectNulls).toBe(false);

    // 当天 0–24 时整段，提示框对齐点取正午：15:00 的采样点落在同一天的降雨块内。
    const [middle, value, start, end] = option.series[4].data[0].value;
    const day = (time: string) => new Date(time).getTime();
    expect([middle, value, start, end]).toEqual([day('2026-11-02T12:00:00'), 7, day('2026-11-02T00:00:00'), day('2026-11-03T00:00:00')]);
  });

  it('数值检测到的台阶标在对应方向曲线的发生时刻，附幅度与后续状态', () => {
    const option = buildTimelineOption({
      data: series({
        features: { n: { events: [{ time: '2026-11-03 00:00:00', step_mm: 4, status: '持续' }] } },
      }),
      rainfall: [],
      peers: [],
      mode: 'components',
    }, colors) as Record<string, any>;
    const north = option.series[1];
    expect(north.markPoint.data).toEqual([{ name: '北向台阶 +4.0 mm · 11-03 00:00 · 持续', coord: ['2026-11-03 00:00:00', 4] }]);
    expect(option.series[2].markPoint).toBeUndefined();
  });

  it('同组对比显示本测点水平位移和同组灰线，没有降雨时只有一个绘图区', () => {
    const option = buildTimelineOption({
      data: series(),
      rainfall: [],
      candidates: [],
      peers: [{ name: '测试点 B', points: toDisplacement(series().points) }],
      mode: 'peers',
    }, colors) as Record<string, any>;

    expect(option.grid).toHaveLength(1);
    expect(option.series.map((item: { name: string }) => item.name)).toEqual(['证据区间', '测试点 B', '测试点 A 水平']);
    expect(option.series[1].lineStyle.color).toBe('peer');
  });
});
