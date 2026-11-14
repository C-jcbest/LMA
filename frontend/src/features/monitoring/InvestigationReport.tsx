import { useMemo, type FC } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ArrowUpLeft, CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import type { ConclusionStationArtifact, ConclusionsArtifactData, FollowUpArtifact } from '@/types/envelope';
import { addAskTarget } from './ask-targets';
import { MILLIMETER_DIGITS } from './format';
import {
  answerToMarkdown,
  collectStations,
  findConclusions,
  formatDateRange,
  investigationStatusLabel,
  STATUS_PRIORITY,
} from './investigation';
import { useStationInspector } from './StationInspectorContext';
import { StatusDot } from './status';

const orderedStations = (conclusions: ConclusionsArtifactData) =>
  [...conclusions.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);

/** 超过这个数量的测点时判断头改为紧凑列表，分组问题不会在正文前堆一屏卡片。 */
const MAX_FULL_HEADS = 3;

const STATUS_ACCENT: Record<string, string> = {
  需人工复核: 'var(--status-critical)',
  持续关注: 'var(--status-attention)',
  未见明显变化: 'var(--status-normal)',
};

const KeyFigures: FC<{ station: ConclusionStationArtifact }> = ({ station }) => {
  const figures = station.key_figures;
  if (!figures) return null;
  const items: { label: string; value: string }[] = [];
  if (figures.window_horizontal_change_mm != null) {
    items.push({
      label: `${formatDateRange(figures.begin_time, figures.end_time)} 水平变化`,
      value: `${figures.window_horizontal_change_mm.toFixed(MILLIMETER_DIGITS)} mm`,
    });
  }
  if (figures.cumulative_horizontal_mm != null) {
    items.push({ label: '累计水平偏移', value: `${figures.cumulative_horizontal_mm.toFixed(MILLIMETER_DIGITS)} mm` });
  }
  if (figures.completeness != null) {
    items.push({ label: '数据完整', value: `${Math.round(figures.completeness * 100)}%` });
  }
  if (items.length === 0) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-medium tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
};

/**
 * 判断头：由结论登记的结构化数据渲染，固定位置、固定样式——状态、对象与时段、原因、三个关键数、下一步。
 * 关键数由服务端从依据计算，不靠模型抄数字；点测点名打开该测点依据。章节正文照常完整展开。
 */
export const JudgmentHeader: FC<{ conclusions: ConclusionsArtifactData }> = ({ conclusions }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { openStation } = useStationInspector();
  const stationIds = useMemo(() => new Set(collectStations(parts).map((station) => station.id)), [parts]);
  const stations = orderedStations(conclusions);

  const nameOf = (item: ConclusionStationArtifact) => (
    stationIds.has(item.station_uuid) ? (
      <button type="button" aria-label={`查看 ${item.station_name} 的依据`}
        onClick={() => openStation({ messageId, stationId: item.station_uuid })}
        className="min-w-0 truncate font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        {item.station_name}
      </button>
    ) : <span className="min-w-0 truncate font-medium">{item.station_name}</span>
  );

  if (stations.length > MAX_FULL_HEADS) {
    return (
      <ul aria-label="测点判断" className="judgment-head divide-y rounded-xl border bg-card">
        {stations.map((item) => (
          <li key={item.station_uuid} className="flex min-h-10 items-center gap-2.5 px-3 py-1.5 text-sm">
            <StatusDot status={item.status} />
            <span className="w-24 shrink-0">{investigationStatusLabel(item.status)}</span>
            {nameOf(item)}
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.reason}>{item.reason}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {stations.map((item) => (
        <section key={item.station_uuid} aria-label={`${item.station_name} 判断`}
          className="judgment-head rounded-xl border bg-card px-4 py-3"
          style={{ borderInlineStartColor: STATUS_ACCENT[item.status] ?? 'var(--status-unknown)', borderInlineStartWidth: 3 }}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-2 font-semibold">
              <StatusDot status={item.status} />{investigationStatusLabel(item.status)}
            </span>
            {nameOf(item)}
            <span className="text-muted-foreground tabular-nums">{formatDateRange(item.begin_time, item.end_time)}</span>
          </div>
          <p className="mt-1.5 leading-relaxed">{item.reason}</p>
          <KeyFigures station={item} />
          {item.next_step && <p className="mt-2 text-sm"><span className="text-muted-foreground">下一步：</span>{item.next_step}</p>}
        </section>
      ))}
    </div>
  );
};

/** 业务时间按北京时间解释，转成追问对象使用的毫秒时间戳。 */
const businessMillis = (value: string) => Date.parse(`${value.replace(' ', 'T')}+08:00`);

/**
 * 回答之后的“可以继续”：来自本次调查自身没覆盖的部分，不是通用问题列表。
 * 点击只填入输入框（带上测点和时段作为追问对象），由用户决定是否发送。
 */
export const FollowUps: FC = () => {
  const aui = useAui();
  const parts = useAuiState((state) => state.message.parts);
  const isRunning = useAuiState((state) => state.message.status?.type === 'running');
  const { composerInputRef } = useStationInspector();
  const conclusions = useMemo(() => findConclusions(parts), [parts]);
  const followUps = conclusions?.follow_ups ?? [];
  if (isRunning || followUps.length === 0) return null;

  const stationName = (identifier: string) => (
    conclusions?.stations.find((item) => item.station_uuid === identifier)?.station_name
    ?? collectStations(parts).find((item) => item.id === identifier)?.name
  );
  const pick = (item: FollowUpArtifact) => {
    const name = item.station_uuid ? stationName(item.station_uuid) : undefined;
    if (item.station_uuid && name && item.begin_time && item.end_time) {
      addAskTarget(aui, { stationUuid: item.station_uuid, stationName: name, start: businessMillis(item.begin_time), end: businessMillis(item.end_time) });
    }
    aui.composer().setText(item.question);
    composerInputRef.current?.focus();
  };

  return (
    <div aria-label="可以继续" className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">可以继续</span>
      {followUps.map((item, index) => (
        <button key={item.question} type="button" onClick={() => pick(item)}
          className="follow-up group inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          style={{ animationDelay: `${index * 50}ms` }}>
          {item.question}
          <ArrowUpLeft aria-hidden className="size-3.5 opacity-50 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
};

/** 模型只登记了结论而没有写正文时，用各测点原因补出可读的回答，避免只剩一行标签。 */
export const ConclusionsFallback: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const conclusions = useMemo(() => findConclusions(parts), [parts]);
  const hasText = parts.some((part) => part.type === 'text' && part.text.trim());
  if (!conclusions || hasText) return null;

  return (
    <section data-slot="conclusions-fallback" aria-label="测点结论">
      <ul className="ms-5 list-disc space-y-1.5 leading-7 marker:text-muted-foreground">
        {orderedStations(conclusions).map((item) => (
          <li key={item.station_uuid} className="wrap-anywhere">
            {item.station_name}（{investigationStatusLabel(item.status)}）：{item.reason}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** 官方复制和导出只读取消息正文，引用编号需要换成可读的依据目录。 */
export const AnswerActions: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const markdown = answerToMarkdown(parts);

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '调查回答.md';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <TooltipIconButton tooltip="复制" onClick={() => copyToClipboard(markdown)}>
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </TooltipIconButton>
      <TooltipIconButton tooltip="导出为 Markdown" onClick={download}>
        <DownloadIcon />
      </TooltipIconButton>
    </>
  );
};
