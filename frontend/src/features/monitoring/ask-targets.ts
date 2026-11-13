import type { ComposerState, useAui } from '@assistant-ui/react';

/**
 * 追问对象：用户在图表上选中、要带进下一条消息的测点时间段。
 * 它作为输入框的运行配置随消息发送，服务端校验后存进消息 metadata；草稿里只留用户自己的话。
 */
export interface AskTarget {
  stationUuid: string;
  stationName: string;
  start: number;
  end: number;
}

/** 服务端保存在用户消息 metadata 里的形状，时间为带时区的 ISO 字符串。 */
export interface AskTargetRecord {
  station_uuid: string;
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
    stationName: record.station_name,
    start: Date.parse(record.start),
    end: Date.parse(record.end),
  }));
};

export const toAskTargetRecords = (targets: readonly AskTarget[]): AskTargetRecord[] => targets.map((target) => ({
  station_uuid: target.stationUuid,
  station_name: target.stationName,
  start: new Date(target.start).toISOString(),
  end: new Date(target.end).toISOString(),
}));

const isSameTarget = (a: AskTarget, b: AskTarget) =>
  a.stationUuid === b.stationUuid && a.start === b.start && a.end === b.end;

const setAskTargets = (aui: Aui, targets: AskTarget[]) => {
  const runConfig = aui.composer().getState().runConfig;
  aui.composer().setRunConfig({ ...runConfig, custom: { ...runConfig.custom, [RUN_CONFIG_KEY]: targets } });
};

/** 把一段时间作为追问对象挂到输入框上；草稿为空时补一句默认问题，用户可以直接改写。 */
export function addAskTarget(aui: Aui, target: AskTarget) {
  const current = askTargetsOfRunConfig(aui.composer().getState().runConfig)
    .filter((existing) => !isSameTarget(existing, target));
  setAskTargets(aui, [...current, target].slice(-MAX_ASK_TARGETS));
  if (!aui.composer().getState().text.trim()) {
    aui.composer().setText(`${target.stationName}这段时间发生了什么？`);
  }
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

const isMidnight = (time: number) => {
  const date = new Date(time);
  return date.getHours() === 0 && date.getMinutes() === 0;
};

const formatDay = (time: number) => {
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const formatClock = (time: number) => {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

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

export const askTargetLabel = (target: AskTarget) => `${target.stationName} · ${formatAskRange(target.start, target.end)}`;
