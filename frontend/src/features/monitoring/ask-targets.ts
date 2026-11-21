import type { ToolArtifactEnvelopeFor } from '@/types/envelope';
import type { ChartRange, ChartSelection } from './TimelineChart';
import { chartClock } from './chart-time';
import type { ComposerState, useAui } from '@assistant-ui/react';

/**
 * 追问对象：用户在图表上选中、要带进下一条消息的测点时间段。
 * 它作为输入框的运行配置随消息发送，服务端校验后存进消息 metadata；草稿里只留用户自己的话。
 */
export type AskKind = 'displacement' | 'rainfall';

export interface AskTarget {
  stationUuid?: string;
  kind?: AskKind;
  evidenceId?: string;
  stationName: string;
  start: number;
  end: number;
}

/** 服务端保存在用户消息 metadata 里的形状，时间为带时区的 ISO 字符串。 */
export interface AskTargetRecord {
  station_uuid?: string;
  kind?: AskKind;
  evidence_id?: string;
  station_name: string;
  start: string;
  end: string;
}

type Aui = ReturnType<typeof useAui>;

const RUN_CONFIG_KEY = 'askTargets';
const MESSAGE_METADATA_KEY = 'ask_targets';
/** 与服务端上限一致；超出时丢弃最早加入的一段。 */
const MAX_ASK_TARGETS = 4;
const DAY_MILLIS = 86400e3;

/** 运行时把运行配置当作不透明值传给 stream，这里按输入框写入时的形状读取。 */
export const askTargetsOfRunConfig = (runConfig: unknown): AskTarget[] => {
  const targets = (runConfig as ComposerState['runConfig'] | undefined)?.custom?.[RUN_CONFIG_KEY];
  return Array.isArray(targets) ? (targets as AskTarget[]) : [];
};

export const askTargetsOfMessage = (custom: Record<string, unknown> | undefined): AskTarget[] => {
  const records = custom?.[MESSAGE_METADATA_KEY];
  if (!Array.isArray(records)) {
    return [];
  }
  return (records as AskTargetRecord[]).map((record) => ({
    stationUuid: record.station_uuid,
    kind: record.kind,
    evidenceId: record.evidence_id,
    stationName: record.station_name,
    start: Date.parse(record.start),
    end: Date.parse(record.end),
  }));
};

export const toAskTargetRecords = (targets: readonly AskTarget[]): AskTargetRecord[] => targets.map((target) => ({
  station_uuid: target.stationUuid,
  kind: target.kind,
  evidence_id: target.evidenceId,
  station_name: target.stationName,
  start: new Date(target.start).toISOString(),
  end: new Date(target.end).toISOString(),
}));

const isSameTarget = (a: AskTarget, b: AskTarget) =>
  a.stationUuid === b.stationUuid && a.stationName === b.stationName && a.kind === b.kind
  && a.evidenceId === b.evidenceId && a.start === b.start && a.end === b.end;

const setAskTargets = (aui: Aui, targets: AskTarget[]) => {
  const runConfig = aui.composer().getState().runConfig;
  aui.composer().setRunConfig({ ...runConfig, custom: { ...runConfig.custom, [RUN_CONFIG_KEY]: targets } });
};

/** 只附上选中的资料，草稿始终是用户自己的文字。 */
export function addAskTarget(aui: Aui, target: AskTarget): void {
  const current = askTargetsOfRunConfig(aui.composer().getState().runConfig)
    .filter((existing) => !isSameTarget(existing, target));
  setAskTargets(aui, [...current, target].slice(-MAX_ASK_TARGETS));
}

export function removeAskTarget(aui: Aui, target: AskTarget) {
  const remaining = askTargetsOfRunConfig(aui.composer().getState().runConfig)
    .filter((existing) => !isSameTarget(existing, target));
  setAskTargets(aui, remaining);
}

/** 输入框发送后不会自动清空运行配置，追问对象只属于刚发出的那条消息。 */
export function clearAskTargets(aui: Aui) {
  if (askTargetsOfRunConfig(aui.composer().getState().runConfig).length > 0) {
    setAskTargets(aui, []);
  }
}

const isMidnight = (time: number) => chartClock(time).slice(11) === '00:00' && time % 60000 === 0;

const formatDay = (time: number) => {
  const [, month, day] = chartClock(time).slice(0, 10).split('-');
  return Number(month) + '月' + Number(day) + '日';
};

const formatClock = (time: number) => chartClock(time).slice(11);

/** 整日范围只写日期（结束日按包含计），其余写到分钟；同一天不重复日期。 */
export function formatAskRange(start: number, end: number): string {
  if (isMidnight(start) && isMidnight(end)) {
    const lastDay = end - DAY_MILLIS;
    return lastDay <= start ? formatDay(start) : `${formatDay(start)}–${formatDay(lastDay)}`;
  }
  if (formatDay(start) === formatDay(end)) {
    return `${formatDay(start)} ${formatClock(start)}–${formatClock(end)}`;
  }
  return `${formatDay(start)} ${formatClock(start)}–${formatDay(end)} ${formatClock(end)}`;
}

export const askTargetLabel = (target: AskTarget) => {
  const date = formatAskRange(target.start, target.end);
  if (target.kind === 'rainfall') {
    return date + '降雨 · ' + target.stationName;
  }
  return target.stationName + ' · ' + date + (target.kind === 'displacement' ? '位移' : '');
};

/** 叠加图可能合并多份天气依据。只有整段被一份资料覆盖时才附其编号。 */
export function timelineAskTarget(
  range: ChartRange | ChartSelection,
  series: ToolArtifactEnvelopeFor<'gnss_series'>,
  weather: readonly ToolArtifactEnvelopeFor<'weather'>[],
): AskTarget {
  const kind = range.kind ?? 'displacement';
  let evidenceId = series.evidence_id;
  if (kind === 'rainfall') {
    const begin = chartClock(range.start).slice(0, 10);
    const end = chartClock(range.end - 1).slice(0, 10);
    const matches = weather.filter(({ data }) => data.query.history_start_date <= begin && data.query.history_end_date >= end);
    evidenceId = matches.length === 1 ? matches[0]?.evidence_id : undefined;
  }
  return { ...range, kind, evidenceId, stationUuid: series.data.station_uuid, stationName: series.data.station_name };
}
