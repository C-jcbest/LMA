import { useState, type CSSProperties, type FC } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';
import { ChevronDownIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { Progress } from '@/components/ui/progress';
import { formatMillimeters, StatusDot } from '@/features/monitoring/status';
import { TrendLine } from '@/features/monitoring/TrendLine';
import { cn } from 'cn';

export const SUMMARY_COMPONENT = 'inspection_summary';
export const ROW_COMPONENT = 'station_row';

interface SummaryProps {
  label?: string;
  total?: number;
  screened?: number;
  attention?: number;
  judged?: number;
  status?: 'running' | 'done' | 'error';
  vision_enabled?: boolean;
  elapsed_seconds?: number;
  common_mode_checked?: boolean;
}

interface Trigger {
  kind?: string;
  axis?: string | null;
  window?: 'long' | 'recent' | null;
  text: string;
}

interface QualityNote {
  kind?: string;
  text: string;
}

interface VisionProps {
  status: 'skipped' | 'unavailable' | 'running' | 'done' | 'error';
  shape?: string;
  summary?: string;
  data_quality?: '正常' | '可疑';
  confidence?: '低' | '中' | '高';
  image?: string;
}

interface RowProps {
  station_uuid: string;
  station_name: string;
  group_name: string;
  status: 'pending' | 'screened';
  screening?: string;
  change?: { axis: string; millimeters: number; window_days: number } | null;
  trend?: Array<number | null>;
  triggers?: Trigger[];
  quality?: QualityNote[];
  vision?: VisionProps;
}

const ROW_ORDER: Record<string, number> = { 建议调查: 1, 数据不足: 2, 暂无法分析: 2, 未见明显变化: 3 };
const PENDING_ORDER = 4;

const WINDOW_LABEL = { long: '90 天', recent: '近 7 天' } as const;
const RECENT_PREFIX = '近期小时序列：';

const triggerText = (trigger: Trigger) =>
  trigger.text.startsWith(RECENT_PREFIX) ? trigger.text.slice(RECENT_PREFIX.length) : trigger.text;

function qualitySummary(notes: readonly QualityNote[]): string {
  const spikes = notes.filter((note) => note.kind === 'spike').length;
  const gaps = notes.filter((note) => note.kind === 'gap').length;
  const others = notes.filter((note) => note.kind !== 'spike' && note.kind !== 'gap').map((note) => note.text);
  const parts: string[] = [];
  if (spikes > 0) {
    parts.push(`异常跳点 ${spikes} 处`);
  }
  if (gaps > 0) {
    parts.push(`缺测跨越 ${gaps} 处`);
  }
  return [...parts, ...others].join(' · ');
}

export const InspectionSummaryPart: FC<DataMessagePartProps<SummaryProps>> = ({ data }) => {
  const total = data.total ?? 0;
  const screened = data.screened ?? 0;
  const attention = data.attention ?? 0;
  let statusText = <span className="text-shimmer">巡检中</span>;
  if (data.status === 'done') {
    statusText = <span>完成 · 用时 {data.elapsed_seconds ?? 0} 秒</span>;
  } else if (data.status === 'error') {
    statusText = <span className="text-destructive">未完成，已显示的结果保留</span>;
  }
  return (
    <section aria-label="巡检汇总" style={{ order: 0 }} className="mb-3 rounded-lg bg-muted/50 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">{data.label ?? '准备巡检'}</h2>
        <p className="text-sm text-muted-foreground tabular-nums">{statusText}</p>
      </div>
      <Progress className="mt-3 h-1 bg-muted" aria-label="初筛进度" value={total > 0 ? (screened / total) * 100 : 0} />
      <p className="mt-2 text-sm text-muted-foreground tabular-nums">
        已初筛 {screened} / {total}
        <span className="mx-2">·</span>
        <span className={cn(attention > 0 && 'text-status-attention')}>建议调查 {attention}</span>
        {data.vision_enabled && attention > 0 && (
          <><span className="mx-2">·</span>视觉初判 {data.judged ?? 0} / {attention}</>
        )}
      </p>
      {data.vision_enabled === false && (
        <p className="mt-1 text-xs text-muted-foreground">未配置视觉模型，只显示初筛结果。</p>
      )}
      {data.status === 'done' && data.common_mode_checked === false && (
        <p className="mt-1 text-xs text-muted-foreground">单站巡检看不到同组其他测点，未检查同组同向变化。</p>
      )}
    </section>
  );
};

const VisionVerdict: FC<{ vision: VisionProps }> = ({ vision }) => {
  const [showImage, setShowImage] = useState(false);
  if (vision.status === 'skipped') {
    return null;
  }
  if (vision.status === 'running') {
    return <p className="text-shimmer mt-2 text-sm">视觉模型判读曲线中…</p>;
  }
  if (vision.status === 'unavailable') {
    return null;
  }
  if (vision.status === 'error') {
    return <p className="mt-2 text-xs text-muted-foreground">视觉初判未完成，以初筛结果为准。</p>;
  }
  return (
    <div className="mt-2 rounded-md bg-muted/60 px-3 py-2 animate-in fade-in duration-200">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">视觉初判 · {vision.shape}</span>
        <span>把握 {vision.confidence}</span>
        {vision.data_quality === '可疑' && <span className="text-status-attention">数据可疑</span>}
      </p>
      <p className="mt-1 text-sm leading-relaxed">{vision.summary}</p>
      {vision.image && (
        <>
          <button
            type="button"
            aria-expanded={showImage}
            onClick={() => setShowImage((current) => !current)}
            className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-md text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            模型看到的图
            <ChevronDownIcon aria-hidden className={cn('size-3.5 transition-transform', showImage && 'rotate-180')} />
          </button>
          {showImage && <img src={vision.image} alt="交给视觉模型的 90 天位移图" className="mt-1 w-full rounded-md border" />}
        </>
      )}
    </div>
  );
};

export const StationRowPart: FC<DataMessagePartProps<RowProps>> = ({ data }) => {
  const { openStation } = useNavigation();
  const [showAll, setShowAll] = useState(false);
  const isPending = data.status === 'pending';
  const triggers: Trigger[] = data.triggers ?? [];
  const visibleTriggers = showAll ? triggers : triggers.slice(0, 2);
  const qualityNotes: QualityNote[] = data.quality ?? [];
  const quality = qualitySummary(qualityNotes);
  const style: CSSProperties = { order: isPending ? PENDING_ORDER : ROW_ORDER[data.screening ?? ''] ?? 3 };

  return (
    <article aria-label={data.station_name} style={style} className="today-row rounded-lg animate-in fade-in duration-200">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot status={isPending ? null : data.screening} className={cn(isPending && 'animate-pulse')} />
          <button
            type="button"
            onClick={() => openStation(data.station_uuid)}
            className="min-w-0 truncate rounded-sm text-start text-base font-semibold underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {data.station_name}
          </button>
          <span className="shrink-0 text-xs text-muted-foreground">{data.group_name}</span>
          {!isPending && data.screening !== '建议调查' && (
            <span className="shrink-0 text-xs text-muted-foreground">{data.screening}</span>
          )}
        </div>
        <div className="ps-4.5">
          {isPending && <p className="text-shimmer mt-1 text-sm">读取数据并初筛…</p>}
          {visibleTriggers.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm">
              {visibleTriggers.map((trigger) => (
                <li key={trigger.text} className="flex gap-2">
                  <span className="shrink-0 text-xs leading-5 text-muted-foreground">{WINDOW_LABEL[trigger.window ?? 'long']}</span>
                  <span className="min-w-0 wrap-anywhere">{triggerText(trigger)}</span>
                </li>
              ))}
            </ul>
          )}
          {triggers.length > 2 && (
            <button
              type="button"
              onClick={() => setShowAll((current) => !current)}
              className="mt-0.5 min-h-7 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {showAll ? '收起' : `另有 ${triggers.length - 2} 条线索`}
            </button>
          )}
          {quality && <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">数据质量：{quality}</p>}
          {data.vision && <VisionVerdict vision={data.vision} />}
        </div>
      </div>
      <span className="today-row-trend">{data.trend && <TrendLine values={data.trend} emphasized={data.screening === '建议调查'} />}</span>
      <span className="today-row-change tabular-nums">
        {data.change && (
          <>
            <span className="text-base font-medium">{formatMillimeters(data.change.millimeters)}</span>
            <span className="ms-1 text-xs text-muted-foreground">mm {data.change.axis}</span>
            <span className="block text-xs text-muted-foreground">{data.change.window_days} 天变化</span>
          </>
        )}
      </span>
    </article>
  );
};
