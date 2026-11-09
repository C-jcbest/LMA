import type { EChartsCoreOption } from 'echarts/core';
import type {
  GapArtifact,
  GnssArtifactData,
  GnssPointArtifact,
  VisionCandidateArtifact,
  WeatherArtifactData,
} from '@/types/envelope';
import { toFiniteGnssNumber } from './tools/gnssUtils';

const MILLIMETERS_PER_METER = 1000;
const MIN_PEER_OVERLAP_RATIO = 0.5;
const RAINFALL_SERIES_NAME = '日降雨';

const toMillis = (value: string) => new Date(value.replace(' ', 'T')).getTime();

const roundToHundredth = (value: number) => Math.round(value * 100) / 100;

export interface DisplacementPoint {
  time: string;
  n: number | null;
  e: number | null;
  u: number | null;
  h: number | null;
}

/**
 * 相对本窗口首个有效点的变化（mm）。这是窗口内变化，不是相对平台固定初始
 * 坐标的累计偏移；序列产物不携带固定基准，图上不得把二者混称。
 * 缺测保持 null，折线在此断开，不转换为 0。
 */
export function toDisplacement(points: readonly GnssPointArtifact[]): DisplacementPoint[] {
  const firstValues: Record<'n' | 'e' | 'u', number | null> = { n: null, e: null, u: null };

  return points.map((point) => {
    const relative = (axis: 'n' | 'e' | 'u') => {
      const value = toFiniteGnssNumber(point[axis]);
      if (value === null) return null;
      firstValues[axis] ??= value;
      return roundToHundredth((value - firstValues[axis]) * MILLIMETERS_PER_METER);
    };
    const n = relative('n');
    const e = relative('e');
    const u = relative('u');
    return {
      time: point.time,
      n,
      e,
      u,
      h: n === null || e === null ? null : roundToHundredth(Math.hypot(n, e)),
    };
  });
}

export const seriesDuration = (data: GnssArtifactData) =>
  toMillis(data.end_time) - toMillis(data.begin_time);

const samplingLabel = (data: GnssArtifactData) => {
  const sampling = data.sampling;
  if (sampling?.mode === 'sample_times' && sampling.sample_times?.length) {
    return `每日 ${sampling.sample_times.join('、')}`;
  }
  if (sampling?.mode === 'frequency' && sampling.frequency_effective) {
    const frequency = sampling.frequency_effective;
    return frequency.endsWith('h') ? `每 ${frequency.slice(0, -1)} 小时` : `每 ${frequency} 分钟`;
  }
  return '每小时';
};

export const seriesLabel = (data: GnssArtifactData) =>
  `${data.begin_time.slice(5, 10)} 至 ${data.end_time.slice(5, 10)} · ${samplingLabel(data)}`;

export interface DailyRainfall {
  date: string;
  value: number;
  isForecast: boolean;
}

/** 按日合并降雨；同一天既有历史又有预报时以历史为准。 */
export function dailyRainfallWithin(
  weather: readonly WeatherArtifactData[],
  begin: string,
  end: string,
): DailyRainfall[] {
  const beginDate = begin.slice(0, 10);
  const endDate = end.slice(0, 10);
  const byDate = new Map<string, DailyRainfall>();

  const collect = (daily: WeatherArtifactData['forecast'], isForecast: boolean) => {
    daily?.daily.time.forEach((date, index) => {
      const value = daily.daily.precipitation_sum?.[index];
      if (typeof value === 'number' && date >= beginDate && date <= endDate) {
        byDate.set(date, { date, value, isForecast });
      }
    });
  };
  for (const item of weather) collect(item.forecast, true);
  for (const item of weather) collect(item.history, false);

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface PeerSeries {
  name: string;
  points: DisplacementPoint[];
}

/** 同组对比只取与当前窗口重叠过半的序列，并在共同窗口内重新取首点。 */
export function peerSeriesFor(
  current: GnssArtifactData,
  peers: readonly { name: string; series: readonly GnssArtifactData[] }[],
): PeerSeries[] {
  const windowStart = toMillis(current.begin_time);
  const windowEnd = toMillis(current.end_time);
  const windowDuration = windowEnd - windowStart;
  const result: PeerSeries[] = [];

  for (const peer of peers) {
    let bestSeries: GnssArtifactData | null = null;
    let bestOverlap = 0;
    for (const candidate of peer.series) {
      const overlap = Math.min(windowEnd, toMillis(candidate.end_time))
        - Math.max(windowStart, toMillis(candidate.begin_time));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSeries = candidate;
      }
    }
    if (!bestSeries || bestOverlap < windowDuration * MIN_PEER_OVERLAP_RATIO) continue;

    const pointsInWindow = bestSeries.points.filter((point) => {
      const time = toMillis(point.time);
      return time >= windowStart && time <= windowEnd;
    });
    result.push({ name: peer.name, points: toDisplacement(pointsInWindow) });
  }
  return result;
}

export interface ChartColors {
  text: string;
  mutedText: string;
  grid: string;
  surface: string;
  border: string;
  primary: string;
  north: string;
  east: string;
  up: string;
  rain: string;
  peer: string;
  candidate: string;
  gap: string;
}

export type TimelineMode = 'components' | 'peers';

export interface TimelineInput {
  data: GnssArtifactData;
  rainfall: readonly DailyRainfall[];
  candidates: readonly VisionCandidateArtifact[];
  peers: readonly PeerSeries[];
  mode: TimelineMode;
}

const displacementLine = (
  name: string,
  values: readonly (readonly [string, number | null])[],
  color: string,
  width: number,
) => ({
  name,
  type: 'line',
  xAxisIndex: 0,
  yAxisIndex: 0,
  data: values,
  showSymbol: false,
  connectNulls: false,
  lineStyle: { color, width },
  itemStyle: { color },
  emphasis: { disabled: true },
});

const evidenceBands = (
  gaps: readonly GapArtifact[],
  candidates: readonly VisionCandidateArtifact[],
  colors: ChartColors,
) => ({
  silent: true,
  label: { color: colors.mutedText, fontSize: 12, position: 'insideTop' },
  data: [
    ...gaps.map((gap) => [
      { name: '缺测', xAxis: gap.from, itemStyle: { color: colors.gap } },
      { xAxis: gap.to },
    ]),
    ...candidates.map((candidate) => [
      { name: `候选 ${candidate.metric}`, xAxis: candidate.start_at, itemStyle: { color: colors.candidate } },
      { xAxis: candidate.end_at },
    ]),
  ],
});

/** 位移、降雨、缺测和视觉候选共用同一时间轴，时间对齐由图本身完成。 */
export function buildTimelineOption(input: TimelineInput, colors: ChartColors): EChartsCoreOption {
  const { data, rainfall, candidates, peers, mode } = input;
  const displacement = toDisplacement(data.points);
  const hasRainfall = rainfall.length > 0;
  const axisIndexes = hasRainfall ? [0, 1] : [0];

  const lineValues = (key: 'n' | 'e' | 'u' | 'h') =>
    displacement.map((point) => [point.time, point[key]] as const);

  const lines = mode === 'components'
    ? [
        displacementLine('北向 N', lineValues('n'), colors.north, 1.75),
        displacementLine('东向 E', lineValues('e'), colors.east, 1.75),
        displacementLine('垂直 U', lineValues('u'), colors.up, 1.75),
      ]
    : [
        ...peers.map((peer) => displacementLine(
          peer.name,
          peer.points.map((point) => [point.time, point.h] as const),
          colors.peer,
          1,
        )),
        displacementLine(`${data.station_name} 水平`, lineValues('h'), colors.primary, 2.25),
      ];

  // 证据带放在独立的空序列上，用图例隐藏某个方向时缺测和候选区间仍然可见。
  const bandSeries = {
    ...displacementLine('证据区间', [], colors.mutedText, 0),
    markArea: evidenceBands(data.summary.gaps, candidates, colors),
  };

  const axisLine = { lineStyle: { color: colors.border } };
  const axisLabel = { color: colors.mutedText, fontSize: 12, hideOverlap: true };
  const splitLine = { lineStyle: { color: colors.grid } };
  const timeAxis = {
    type: 'time',
    min: data.begin_time,
    max: data.end_time,
    axisLine,
    axisTick: { show: false },
    splitLine: { show: false },
  };

  return {
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    grid: hasRainfall
      ? [
          { left: 48, right: 12, top: 44, bottom: 156 },
          { left: 48, right: 12, height: 64, bottom: 64 },
        ]
      : [{ left: 48, right: 12, top: 44, bottom: 64 }],
    legend: {
      top: 0,
      left: 44,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: colors.text, fontSize: 12 },
      // 同组灰线只作背景，不进入图例。
      data: [
        ...(mode === 'components' ? lines : lines.slice(-1)).map((line) => line.name),
        ...(hasRainfall ? [RAINFALL_SERIES_NAME] : []),
      ],
    },
    xAxis: hasRainfall
      ? [
          { ...timeAxis, gridIndex: 0, axisLabel: { show: false } },
          { ...timeAxis, gridIndex: 1, axisLabel },
        ]
      : [{ ...timeAxis, gridIndex: 0, axisLabel }],
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: 'mm', nameTextStyle: { color: colors.mutedText }, axisLabel, splitLine },
      ...(hasRainfall
        ? [{ type: 'value', gridIndex: 1, min: 0, splitNumber: 2, axisLabel, splitLine }]
        : []),
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: colors.mutedText } },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      textStyle: { color: colors.text, fontSize: 13 },
      valueFormatter: (value: unknown) => (typeof value === 'number' ? `${value.toFixed(2)} mm` : '缺测'),
    },
    // brush 需要 toolbox 组件，拖选由图表本身触发，不显示工具栏。
    toolbox: { show: false },
    brush: {
      xAxisIndex: axisIndexes,
      brushType: 'lineX',
      brushMode: 'single',
      outOfBrush: { colorAlpha: 1 },
      brushStyle: { color: colors.gap, borderWidth: 0 },
    },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: axisIndexes,
        filterMode: 'none',
        height: 22,
        bottom: 8,
        left: 48,
        right: 12,
        showDetail: false,
        borderColor: colors.border,
        fillerColor: colors.gap,
        handleStyle: { color: colors.surface, borderColor: colors.mutedText },
        moveHandleSize: 0,
      },
    ],
    series: [
      bandSeries,
      ...lines,
      ...(hasRainfall
        ? [{
            name: RAINFALL_SERIES_NAME,
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 1,
            barMaxWidth: 14,
            barMinWidth: 2,
            itemStyle: { color: colors.rain },
            data: rainfall.map((day) => ({
              value: [`${day.date} 12:00:00`, day.value],
              itemStyle: { color: colors.rain, opacity: day.isForecast ? 0.45 : 1 },
            })),
          }]
        : []),
    ],
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

export const formatChartTime = (millis: number) => {
  const date = new Date(millis);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
