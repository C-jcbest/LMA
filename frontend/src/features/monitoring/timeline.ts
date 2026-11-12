import type { EChartsCoreOption } from 'echarts/core';
import type {
  GapArtifact,
  GnssArtifactData,
  GnssPointArtifact,
  WeatherArtifactData,
} from '@/types/envelope';
import { toFiniteGnssNumber } from './tools/gnssUtils';

const MILLIMETERS_PER_METER = 1000;
const MIN_PEER_OVERLAP_RATIO = 0.5;
const RAINFALL_SERIES_NAME = '日降雨';
const BAND_SERIES_NAME = '证据区间';
const DAY_MILLIS = 24 * 60 * 60 * 1000;
const AXES = ['n', 'e', 'u'] as const;

type Axis = (typeof AXES)[number];

const toMillis = (value: string) => new Date(value.replace(' ', 'T')).getTime();

const roundToHundredth = (value: number) => Math.round(value * 100) / 100;

export interface DisplacementPoint {
  time: string;
  n: number | null;
  e: number | null;
  u: number | null;
  h: number | null;
}

export type ReferenceCoordinates = Record<Axis, number | null>;

/** 平台登记的固定参考坐标（m）；旧依据或平台未登记的方向为 null。 */
export function referenceOf(data: GnssArtifactData): ReferenceCoordinates {
  const coordinates = data.reference?.coordinates_m;
  const record = typeof coordinates === 'object' && coordinates !== null ? coordinates as Record<string, unknown> : {};
  return { n: toFiniteGnssNumber(record.n), e: toFiniteGnssNumber(record.e), u: toFiniteGnssNumber(record.u) };
}

export type DisplacementBasis = 'fixed' | 'partial' | 'window';

export function displacementBasis(data: GnssArtifactData): DisplacementBasis {
  const reference = referenceOf(data);
  const fixedAxes = AXES.filter((axis) => reference[axis] !== null).length;
  if (fixedAxes === AXES.length) return 'fixed';
  return fixedAxes === 0 ? 'window' : 'partial';
}

const BASIS_LABELS: Record<DisplacementBasis, string> = {
  fixed: '相对固定参考的累计位移',
  partial: '部分方向平台未登记固定参考，这些方向相对本窗口首点',
  window: '平台未登记固定参考，相对本窗口首点',
};

export const displacementBasisLabel = (data: GnssArtifactData) => BASIS_LABELS[displacementBasis(data)];

/**
 * 位移（mm）：有固定参考的方向是累计位移，没有的方向退回本窗口首个有效点，
 * 并由 displacementBasisLabel 向用户说明。缺测保持 null，折线在此断开，不转换为 0。
 */
export function toDisplacement(
  points: readonly GnssPointArtifact[],
  reference: ReferenceCoordinates = { n: null, e: null, u: null },
): DisplacementPoint[] {
  const baseValues: ReferenceCoordinates = { ...reference };

  return points.map((point) => {
    const relative = (axis: Axis) => {
      const value = toFiniteGnssNumber(point[axis]);
      if (value === null) return null;
      baseValues[axis] ??= value;
      return roundToHundredth((value - baseValues[axis]) * MILLIMETERS_PER_METER);
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

export const displacementOf = (data: GnssArtifactData) => toDisplacement(data.points, referenceOf(data));

/** 窗口内最后一个水平分量齐全的点；用于地图上的位移方向。 */
export function latestHorizontal(data: GnssArtifactData): { north: number; east: number } | null {
  const points = displacementOf(data);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.n !== null && point.e !== null) {
      return { north: point.n, east: point.e };
    }
  }
  return null;
}

export const seriesDuration = (data: GnssArtifactData) =>
  toMillis(data.end_time) - toMillis(data.begin_time);

const samplingLabel = (data: GnssArtifactData) => {
  const sampling = data.sampling;
  if (sampling?.mode === 'sample_times' && sampling.sample_times?.length) {
    return `每日 ${sampling.sample_times.join('、')}`;
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

/** 同组对比只取与当前窗口重叠过半的序列，位移基准与本测点一致（有固定参考时为累计位移）。 */
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
    result.push({ name: peer.name, points: toDisplacement(pointsInWindow, referenceOf(bestSeries)) });
  }
  return result;
}

export interface StepEvent {
  axis: Axis | 'h';
  time: string;
  stepMillimeters: number;
  status: string;
}

/** 服务端在本窗口检测到的台阶候选（数值特征 events），不是视觉判断。 */
export function stepEventsOf(data: GnssArtifactData, axes: readonly (Axis | 'h')[]): StepEvent[] {
  const events: StepEvent[] = [];
  for (const axis of axes) {
    const axisEvents = data.features?.[axis]?.events;
    if (!Array.isArray(axisEvents)) continue;
    for (const event of axisEvents) {
      if (typeof event !== 'object' || event === null) continue;
      const { time, step_mm: step, status } = event as Record<string, unknown>;
      if (typeof time === 'string' && typeof step === 'number') {
        events.push({ axis, time, stepMillimeters: step, status: typeof status === 'string' ? status : '' });
      }
    }
  }
  return events;
}

const AXIS_LABELS: Record<Axis | 'h', string> = { n: '北向', e: '东向', u: '垂直', h: '水平' };

const formatSigned = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;

export const stepEventText = (event: StepEvent) =>
  `${AXIS_LABELS[event.axis]}台阶 ${formatSigned(event.stepMillimeters)} mm · ${event.time.slice(5, 16)}${event.status ? ` · ${event.status}` : ''}`;

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
  gap: string;
}

export type TimelineMode = 'components' | 'peers';

export interface TimelineInput {
  data: GnssArtifactData;
  rainfall: readonly DailyRainfall[];
  peers: readonly PeerSeries[];
  mode: TimelineMode;
}

/** 台阶标在曲线上的发生时刻，悬停看幅度和后续状态；不再用区间色块覆盖曲线。 */
const stepMarks = (events: readonly StepEvent[], points: readonly DisplacementPoint[], color: string) => {
  if (events.length === 0) return undefined;
  const valueAt = new Map(points.map((point) => [point.time, point]));
  return {
    symbol: 'triangle',
    symbolSize: 9,
    itemStyle: { color, borderColor: '#fff', borderWidth: 1 },
    label: { show: false },
    tooltip: { trigger: 'item', formatter: (params: { name: string }) => params.name },
    data: events.flatMap((event) => {
      const value = valueAt.get(event.time)?.[event.axis];
      return typeof value === 'number' ? [{ name: stepEventText(event), coord: [event.time, value] }] : [];
    }),
  };
};

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

const gapBands = (gaps: readonly GapArtifact[], colors: ChartColors) => ({
  silent: true,
  label: { color: colors.mutedText, fontSize: 12, position: 'insideTop' },
  data: gaps.map((gap) => [
    { name: '缺测', xAxis: gap.from, itemStyle: { color: colors.gap } },
    { xAxis: gap.to },
  ]),
});

/** 日降雨是整日累计，画成覆盖当天 0–24 时的色块，任何采样时刻都落在当天之内。 */
const rainfallSeries = (rainfall: readonly DailyRainfall[], colors: ChartColors) => ({
  name: RAINFALL_SERIES_NAME,
  type: 'custom',
  xAxisIndex: 1,
  yAxisIndex: 1,
  clip: true,
  // 取当天正午作为提示框的对齐点：当天任一时刻离它都比离相邻日更近。
  encode: { x: 0, y: 1 },
  itemStyle: { color: colors.rain },
  data: rainfall.map((day) => {
    const start = toMillis(`${day.date} 00:00:00`);
    return { value: [start + DAY_MILLIS / 2, day.value, start, start + DAY_MILLIS, day.isForecast ? 1 : 0] };
  }),
  renderItem: (
    _params: unknown,
    api: { value: (dimension: number) => number; coord: (value: [number, number]) => [number, number] },
  ) => {
    const [left, top] = api.coord([api.value(2), api.value(1)]);
    const [right, bottom] = api.coord([api.value(3), 0]);
    return {
      type: 'rect',
      shape: { x: left + 1, y: top, width: Math.max(1, right - left - 2), height: bottom - top },
      style: { fill: colors.rain, opacity: api.value(4) === 1 ? 0.45 : 1 },
    };
  },
});

interface TooltipItem {
  seriesName: string;
  marker: string;
  value: unknown;
  axisValue?: number | string;
}

const formatTooltip = (params: TooltipItem | TooltipItem[]) => {
  const items = (Array.isArray(params) ? params : [params]).filter((item) => item.seriesName !== BAND_SERIES_NAME);
  const lines = items.map((item) => {
    const value = Array.isArray(item.value) ? item.value[1] : item.value;
    const text = typeof value === 'number' ? `${value.toFixed(2)} mm` : '缺测';
    if (item.seriesName === RAINFALL_SERIES_NAME && Array.isArray(item.value)) {
      const day = formatChartTime(Number(item.value[2])).slice(5, 10);
      return `${item.marker}${day} 日降雨 ${text}`;
    }
    return `${item.marker}${item.seriesName} ${text}`;
  });
  const axisValue = items[0]?.axisValue;
  const header = typeof axisValue === 'number' ? formatChartTime(axisValue) : String(axisValue ?? '');
  return [header, ...lines].join('<br/>');
};

/** 位移、降雨、缺测和台阶共用同一时间轴，时间对齐由图本身完成。 */
export function buildTimelineOption(input: TimelineInput, colors: ChartColors): EChartsCoreOption {
  const { data, rainfall, peers, mode } = input;
  const displacement = displacementOf(data);
  const hasRainfall = rainfall.length > 0;
  const axisIndexes = hasRainfall ? [0, 1] : [0];

  const lineValues = (key: 'n' | 'e' | 'u' | 'h') =>
    displacement.map((point) => [point.time, point[key]] as const);
  const withSteps = (line: ReturnType<typeof displacementLine>, axis: Axis | 'h', color: string) => {
    const markPoint = stepMarks(stepEventsOf(data, [axis]), displacement, color);
    return markPoint ? { ...line, markPoint } : line;
  };

  const lines = mode === 'components'
    ? [
        withSteps(displacementLine('北向 N', lineValues('n'), colors.north, 1.75), 'n', colors.north),
        withSteps(displacementLine('东向 E', lineValues('e'), colors.east, 1.75), 'e', colors.east),
        withSteps(displacementLine('垂直 U', lineValues('u'), colors.up, 1.75), 'u', colors.up),
      ]
    : [
        ...peers.map((peer) => displacementLine(
          peer.name,
          peer.points.map((point) => [point.time, point.h] as const),
          colors.peer,
          1,
        )),
        withSteps(displacementLine(`${data.station_name} 水平`, lineValues('h'), colors.primary, 2.25), 'h', colors.primary),
      ];

  // 缺测带放在独立的空序列上，用图例隐藏某个方向时缺测区间仍然可见。
  const bandSeries = {
    ...displacementLine(BAND_SERIES_NAME, [], colors.mutedText, 0),
    markArea: gapBands(data.summary.gaps, colors),
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
      formatter: formatTooltip,
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
      ...(hasRainfall ? [rainfallSeries(rainfall, colors)] : []),
    ],
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

export const formatChartTime = (millis: number) => {
  const date = new Date(millis);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const rangeQuestion = (stationName: string, range: { start: number; end: number }) =>
  `${stationName} ${formatChartTime(range.start)} 至 ${formatChartTime(range.end)} 这段发生了什么？`;
