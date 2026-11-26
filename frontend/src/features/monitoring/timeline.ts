import { chartClock, chartMillis as toMillis } from './chart-time';
import type { ScreeningFinding } from '@/services/api';
import type { EChartsCoreOption } from 'echarts/core';
import type {
  GapArtifact,
  GnssArtifactData,
  GnssPointArtifact,
  WeatherArtifactData,
} from '@/types/envelope';
import { formatSigned, MILLIMETER_DIGITS } from './format';
import { toFiniteGnssNumber } from './tools/gnssUtils';

const MILLIMETERS_PER_METER = 1000;
const MIN_PEER_OVERLAP_RATIO = 0.5;
const RAINFALL_SERIES_NAME = '日降雨';
const GAP_SERIES_NAME = '缺测';
const STEP_SERIES_NAME = '台阶';
const DAY_MILLIS = 24 * 60 * 60 * 1000;
const AXES = ['n', 'e', 'u'] as const;

type Axis = (typeof AXES)[number];

const roundToHundredth = (value: number) => Math.round(value * 100) / 100;

export interface DisplacementPoint {
  time: string;
  n: number | null;
  e: number | null;
  u: number | null;
  h: number | null;
}

export type ReferenceCoordinates = Record<Axis, number | null>;

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

export interface HorizontalSample {
  time: string;
  north: number;
  east: number;
}

export function horizontalTrack(data: GnssArtifactData, maxSamples = 240): HorizontalSample[] {
  const samples = displacementOf(data).flatMap((point) => (
    point.n === null || point.e === null ? [] : [{ time: point.time, north: point.n, east: point.e }]
  ));
  if (samples.length <= maxSamples) {
    return samples;
  }
  const step = (samples.length - 1) / (maxSamples - 1);
  return Array.from({ length: maxSamples }, (_, index) => samples[Math.round(index * step)]!);
}

export function comparedStationNames(data: GnssArtifactData): string[] {
  const names = data.comparisons?.station_names;
  if (typeof names !== 'object' || names === null) {
    return [];
  }
  return Object.entries(names as Record<string, unknown>)
    .filter(([uuid, name]) => uuid !== data.station_uuid && typeof name === 'string')
    .map(([, name]) => name as string);
}

export function seriesTitle(data: GnssArtifactData): string {
  const compared = comparedStationNames(data);
  return compared.length > 0 ? `${data.station_name} 与 ${compared.join('、')} 对比` : `${data.station_name} 位移`;
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
}

export function stepEventsOf(data: GnssArtifactData, axes: readonly (Axis | 'h')[]): StepEvent[] {
  const events: StepEvent[] = [];
  for (const axis of axes) {
    const axisEvents = data.features?.[axis]?.events;
    if (!Array.isArray(axisEvents)) continue;
    for (const event of axisEvents) {
      if (typeof event !== 'object' || event === null) continue;
      const { time, step_mm: step } = event as Record<string, unknown>;
      if (typeof time === 'string' && typeof step === 'number') {
        events.push({ axis, time, stepMillimeters: step });
      }
    }
  }
  return events;
}

const AXIS_LABELS: Record<Axis | 'h', string> = { n: '北向', e: '东向', u: '垂直', h: '水平' };


export const stepEventText = (event: StepEvent) =>
  `${AXIS_LABELS[event.axis]}台阶 ${formatSigned(event.stepMillimeters, MILLIMETER_DIGITS)} mm · ${event.time.slice(5, 16)}`;

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
  findings?: readonly ScreeningFinding[];
}

const stepMarks = (
  events: readonly StepEvent[],
  points: readonly DisplacementPoint[],
  colorOf: (axis: Axis | 'h') => string,
  borderColor: string,
) => {
  const valueAt = new Map(points.map((point) => [point.time, point]));
  return {
    symbol: 'triangle',
    symbolSize: 9,
    label: { show: false },
    tooltip: { trigger: 'item', formatter: (params: { name: string }) => params.name },
    data: events.flatMap((event) => {
      const value = valueAt.get(event.time)?.[event.axis];
      if (typeof value !== 'number') {
        return [];
      }
      const color = colorOf(event.axis);
      return [{ name: stepEventText(event), coord: [toMillis(event.time), value], itemStyle: { color, borderColor, borderWidth: 1.25 } }];
    }),
  };
};

const displacementLine = (
  name: string,
  values: readonly (readonly [number, number | null])[],
  color: string,
  width: number,
  emphasisFocus: 'none' | 'series' = 'none',
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
  emphasis: emphasisFocus === 'series' ? { focus: 'series' as const, lineStyle: { width: width + 0.75 } } : { disabled: true },
});

const gapBands = (gaps: readonly GapArtifact[], colors: ChartColors) => ({
  silent: true,
  label: { show: false },
  data: gaps.map((gap) => [
    { xAxis: toMillis(gap.from), itemStyle: { color: colors.gap } },
    { xAxis: toMillis(gap.to) },
  ]),
});

const rainfallSeries = (rainfall: readonly DailyRainfall[], colors: ChartColors) => ({
  name: RAINFALL_SERIES_NAME,
  type: 'custom',
  xAxisIndex: 1,
  yAxisIndex: 1,
  clip: true,
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
  const items = (Array.isArray(params) ? params : [params])
    .filter((item) => item.seriesName !== GAP_SERIES_NAME && item.seriesName !== STEP_SERIES_NAME);
  const lines = items.map((item) => {
    const value = Array.isArray(item.value) ? item.value[1] : item.value;
    if (item.seriesName === RAINFALL_SERIES_NAME && Array.isArray(item.value)) {
      const text = typeof value === 'number' ? `${value.toFixed(1)} mm` : '缺测';
      const day = formatChartTime(Number(item.value[2])).slice(5, 10);
      return `${item.marker}${day} 日降雨 ${text}`;
    }
    const text = typeof value === 'number' ? `${formatSigned(value, MILLIMETER_DIGITS)} mm` : '缺测';
    return `${item.marker}${item.seriesName} ${text}`;
  });
  const axisValue = items[0]?.axisValue;
  const header = typeof axisValue === 'number' ? formatChartTime(axisValue) : String(axisValue ?? '');
  return [header, ...lines].join('<br/>');
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function buildTimelineOption(input: TimelineInput, colors: ChartColors): EChartsCoreOption {
  const { data, rainfall, peers, mode, findings } = input;
  const reducedMotion = prefersReducedMotion();
  const displacement = displacementOf(data);
  const hasRainfall = rainfall.length > 0;
  const axisIndexes = hasRainfall ? [0, 1] : [0];

  const lineValues = (key: 'n' | 'e' | 'u' | 'h') =>
    displacement.map((point) => [toMillis(point.time), point[key]] as const);

  const lines = mode === 'components'
    ? [
        displacementLine('北向 N', lineValues('n'), colors.north, 1.75),
        displacementLine('东向 E', lineValues('e'), colors.east, 1.75),
        displacementLine('垂直 U', lineValues('u'), colors.up, 1.75),
      ]
    : [
        ...peers.map((peer) => displacementLine(
          peer.name,
          peer.points.map((point) => [toMillis(point.time), point.h] as const),
          colors.peer,
          1.15,
          'series',
        )),
        displacementLine(`${data.station_name} 水平`, lineValues('h'), colors.primary, 2.25, 'series'),
      ];

  const axisColors: Record<Axis | 'h', string> = { n: colors.north, e: colors.east, u: colors.up, h: colors.primary };
  const steps = stepEventsOf(data, mode === 'components' ? AXES : ['h']);
  const hasSteps = steps.length > 0;
  const hasGaps = data.summary.gaps.length > 0;

  const gapSeries = {
    ...displacementLine(GAP_SERIES_NAME, [], colors.gap, 0),
    markArea: gapBands(data.summary.gaps, colors),
  };
  const inspectionMarkers = (findings ?? []).flatMap((finding) => finding.time ? [{ name: finding.text, xAxis: toMillis(finding.time) }] : []);
  const stepSeries = {
    ...displacementLine(STEP_SERIES_NAME, [], colors.mutedText, 0),
    markPoint: stepMarks(steps, displacement, (axis) => axisColors[axis], colors.surface),
    ...(inspectionMarkers.length > 0 ? {
      markLine: {
        symbol: 'none',
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: '巡检线索',
          color: colors.mutedText,
          fontSize: 11,
        },
        tooltip: { trigger: 'item', formatter: (params: { name: string }) => params.name },
        lineStyle: { color: colors.mutedText, type: 'dashed' },
        data: inspectionMarkers,
      },
    } : {}),
  };

  const axisLine = { lineStyle: { color: colors.border } };
  const axisLabel = { color: colors.mutedText, fontSize: 12, hideOverlap: true };
  const splitLine = { lineStyle: { color: colors.grid } };
  const timeAxis = {
    type: 'time',
    min: toMillis(data.begin_time),
    max: toMillis(data.end_time),
    axisLabel: { ...axisLabel, formatter: (millis: number) => {
      const time = chartClock(millis);
      const day = time.slice(5, 10);
      if (time.endsWith('00:00') || time.endsWith('08:00')) return day;
      return time.slice(5);
    } },
    axisLine,
    axisTick: { show: false },
    splitLine: { show: false },
  };

  return {
    animation: !reducedMotion,
    animationDuration: 0,
    animationDurationUpdate: reducedMotion ? 0 : 180,
    animationEasingUpdate: 'cubicOut',
    useUTC: true,
    textStyle: { fontFamily: 'inherit' },
    grid: hasRainfall
      ? [
          { left: 48, right: 12, top: 44, bottom: 176 },
          { left: 48, right: 12, height: 64, bottom: 64 },
        ]
      : [{ left: 48, right: 12, top: 44, bottom: 64 }],
    legend: {
      top: 0,
      left: 44,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: colors.text, fontSize: 12 },
      data: [
        ...(mode === 'components' ? lines : lines.slice(-1)).map((line) => line.name),
        ...(hasRainfall ? [RAINFALL_SERIES_NAME] : []),
        ...(hasSteps ? [{ name: STEP_SERIES_NAME, icon: 'triangle', itemStyle: { color: colors.mutedText } }] : []),
        ...(hasGaps ? [{ name: GAP_SERIES_NAME, icon: 'rect', itemStyle: { color: colors.gap } }] : []),
      ],
    },
    xAxis: hasRainfall
      ? [
          { ...timeAxis, gridIndex: 0, axisLabel: { show: false } },
          { ...timeAxis, gridIndex: 1 },
        ]
      : [{ ...timeAxis, gridIndex: 0 }],
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: 'mm', nameTextStyle: { color: colors.mutedText }, axisLabel, splitLine },
      ...(hasRainfall
        ? [{ type: 'value', gridIndex: 1, min: 0, splitNumber: 2, name: 'mm', nameTextStyle: { color: colors.mutedText }, axisLabel, splitLine }]
        : []),
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: colors.mutedText } },
    tooltip: {
      trigger: 'axis',
      confine: true,
      transitionDuration: reducedMotion ? 0 : 0.12,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      textStyle: { color: colors.text, fontSize: 13 },
      formatter: formatTooltip,
    },
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
      gapSeries,
      ...lines,
      stepSeries,
      ...(hasRainfall ? [rainfallSeries(rainfall, colors)] : []),
    ],
  };
}

export const formatChartTime = chartClock;
