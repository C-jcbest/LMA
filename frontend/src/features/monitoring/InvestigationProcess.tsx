import { useEffect, useMemo, useState, type FC } from 'react';
import { useAuiState, type AssistantState } from '@assistant-ui/react';
import { AlertCircleIcon, CheckIcon, ChevronRightIcon, MinusIcon } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ToolArtifactEnvelope } from '@/types/envelope';
import { ComputationResultView } from './tools/ComputationResultView';
import { EmptyResultView } from './tools/EmptyResultView';
import { StationResultView } from './tools/StationResultView';
import { WeatherResultView } from './tools/WeatherResultView';
import {
  buildSteps,
  collectStations,
  findConclusions,
  type InvestigationStep,
  type StationEvidence,
  type StepState,
} from './investigation';
import { ConclusionStatusStrip } from './InvestigationReport';
import { useStationInspector } from './StationInspectorContext';
import { displacementOf, seriesDuration } from './timeline';

const MAX_VISIBLE_STATIONS = 6;
const SPARKLINE_WIDTH = 40;
const SPARKLINE_HEIGHT = 14;

const isMessageRunning = (state: AssistantState) => state.message.status?.type === 'running';

/** 一次调查常要一分钟以上，等过这么久后告诉用户可以先去做别的。 */
const LEAVE_HINT_AFTER_SECONDS = 30;

// 切换页面后同一条回答会重新挂载；开始时间按消息记住，用时不会从零重新计。
// 刷新页面后接上的运行从重新打开时算起。
const runStartTimes = new Map<string, number>();

/** 只在回答运行中渲染；不放进 status 区域，每秒变化的数字不应反复打断读屏。 */
const RunElapsed: FC<{ messageId: string }> = ({ messageId }) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  let startedAt = runStartTimes.get(messageId);
  if (startedAt === undefined) {
    startedAt = Date.now();
    runStartTimes.set(messageId, startedAt);
  }
  const seconds = Math.floor((now - startedAt) / 1000);
  if (seconds < 1) {
    return null;
  }
  return (
    <span className="shrink-0 text-muted-foreground tabular-nums">
      {seconds} 秒{seconds >= LEAVE_HINT_AFTER_SECONDS && ' · 可先离开，调查会继续'}
    </span>
  );
};

/** 测点没有可绘制序列时不画趋势，用名称本身作入口。 */
export const StationSparkline: FC<{ station: StationEvidence }> = ({ station }) => {
  const longest = [...station.series].sort((a, b) => seriesDuration(b.data) - seriesDuration(a.data))[0];
  const values = useMemo(
    () => (longest ? displacementOf(longest.data).map((point) => point.h) : []),
    [longest],
  );
  return <Sparkline values={values} />;
};

export const Sparkline: FC<{ values: readonly (number | null)[] }> = ({ values }) => {
  const validValues = values.filter((value): value is number => value !== null);
  if (validValues.length < 2) return null;

  const max = Math.max(...validValues);
  const min = Math.min(...validValues);
  const span = max - min || 1;
  let startsSegment = true;
  const coordinates = values.map((value, index) => {
    if (value === null) {
      startsSegment = true;
      return '';
    }
    const x = (index / (values.length - 1)) * SPARKLINE_WIDTH;
    const y = SPARKLINE_HEIGHT - 1 - ((value - min) / span) * (SPARKLINE_HEIGHT - 2);
    const command = startsSegment ? 'M' : 'L';
    startsSegment = false;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      className="shrink-0 text-muted-foreground"
      aria-hidden
    >
      <path d={coordinates.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
};

const StepIcon: FC<{ state: StepState }> = ({ state }) => {
  switch (state) {
    case 'running':
      return <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground motion-reduce:animate-none" aria-hidden />;
    case 'failed':
      return <AlertCircleIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
    case 'cancelled':
      return <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
    case 'complete':
      return <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  }
};

export const InlineEvidenceResult: FC<{ envelope: ToolArtifactEnvelope | undefined }> = ({ envelope }) => {
  if (envelope?.kind === 'station_list') {
    return <StationResultView data={envelope.data} />;
  }
  if (envelope?.kind === 'weather') {
    return <WeatherResultView data={envelope.data} />;
  }
  if (envelope?.kind === 'computation') {
    return <ComputationResultView data={envelope.data} />;
  }
  return null;
};

const StepText: FC<{ step: InvestigationStep }> = ({ step }) => (
  <>
    <StepIcon state={step.state} />
    <span className="min-w-0 shrink-0">{step.label}</span>
    {step.detail && <span className="min-w-0 truncate text-muted-foreground">{step.detail}</span>}
  </>
);

const STEP_ROW_CLASS = 'flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-start text-sm';
const STEP_ACTION_CLASS = `${STEP_ROW_CLASS} transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`;

const StepRow: FC<{ step: InvestigationStep; onOpenStation: (name: string) => void }> = ({
  step,
  onOpenStation,
}) => {
  const stationId = step.stationId;
  if (stationId) {
    return (
      <button type="button" className={STEP_ACTION_CLASS} onClick={() => onOpenStation(stationId)}>
        <StepText step={step} />
      </button>
    );
  }
  if (step.inlineEnvelope) {
    return (
      <Collapsible>
        <CollapsibleTrigger className={cn(STEP_ACTION_CLASS, 'group/step')}>
          <StepText step={step} />
          <ChevronRightIcon className="ms-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/step:rotate-90 motion-reduce:transition-none" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent className="py-2 ps-7">
          <InlineEvidenceResult envelope={step.inlineEnvelope} />
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <div className={STEP_ROW_CLASS}>
      <StepText step={step} />
      {step.notice && <EmptyResultView>{step.notice}</EmptyResultView>}
    </div>
  );
};

const headlineOf = (steps: readonly InvestigationStep[], stationCount: number, isRunning: boolean) => {
  const finishedCount = steps.filter((step) => step.state === 'complete').length;
  if (isRunning) {
    const current = steps.filter((step) => step.state === 'running').at(-1);
    const progress = finishedCount > 0 ? ` · 已完成 ${finishedCount} 项` : '';
    return `${current?.label ?? '正在分析查询结果…'}${progress}`;
  }
  if (steps.some((step) => step.state === 'cancelled')) {
    return `已停止 · 完成 ${finishedCount} 项查询`;
  }
  if (steps.some((step) => step.state === 'failed')) {
    return `查询记录 · ${finishedCount} 项已获取`;
  }
  return stationCount > 0
    ? `已调查 ${stationCount} 个测点 · ${steps.length} 项查询`
    : `已完成 ${steps.length} 项查询`;
};

/**
 * 一条回答只呈现一次调查过程，放在回答顶部：先查数据、后写结论，长回答不用翻到底就能看到查了什么、有没有失败。
 * 过程收起时只有一行，生成中高度基本不变，不会推动正文。
 */
export const InvestigationProcess: FC = () => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const isRunning = useAuiState(isMessageRunning);
  const { selection, openStation } = useStationInspector();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFailures, setShowFailures] = useState(true);

  const stations = useMemo(() => collectStations(parts), [parts]);
  const conclusions = useMemo(() => findConclusions(parts), [parts]);
  const steps = useMemo(() => buildSteps(parts, stations), [parts, stations]);
  const failures = steps.filter((step) => step.state === 'failed' && step.envelope?.error);

  if (steps.length === 0) return null;

  const open = (stationId: string) => openStation({ messageId, stationId });
  let headlineState: StepState = 'complete';
  if (isRunning) {
    headlineState = 'running';
  } else if (steps.some((step) => step.state === 'cancelled')) {
    headlineState = 'cancelled';
  } else if (steps.some((step) => step.state === 'failed')) {
    headlineState = 'failed';
  }

  return (
    <div data-slot="investigation" className="investigation-process mb-4 flex flex-col gap-2">
      {steps.length > 0 && <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger className="group/process flex min-h-10 max-w-full items-center gap-2 rounded-lg px-1 text-start text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <StepIcon state={headlineState} />
          <span className={cn('min-w-0 truncate', isRunning && 'text-shimmer')} role={isRunning ? 'status' : undefined}>
            {headlineOf(steps, stations.length, isRunning)}
          </span>
          {isRunning && <RunElapsed messageId={messageId} />}
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/process:rotate-90 motion-reduce:transition-none" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="-ms-1.5 flex flex-col py-1">
            {steps.map((step) => (
              <StepRow key={step.toolCallId} step={step} onOpenStation={open} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>}

      {failures.length > 0 && (
        <Collapsible open={showFailures} onOpenChange={setShowFailures}>
          <CollapsibleTrigger className="group/failures flex min-h-9 items-center gap-2 text-start text-sm text-muted-foreground">
            {failures.length} 项查询未完成
            <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/failures:rotate-90" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {failures.map((step) => (
              <p key={step.toolCallId} className="wrap-anywhere">
                {step.detail && <span>{step.detail}： </span>}{step.envelope!.error!.message}
              </p>
            ))}
            <p>可重新生成本轮回答，或继续提问补查；已取得的依据仍保留。</p>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* 有登记结论时用测点状态作为入口，否则列出涉及的测点；同一入口只出现一次。调查结束时入口淡入，不突然冒出来。 */}
      {!isRunning && conclusions && (
        <div className="animate-in fade-in duration-200 motion-reduce:animate-none">
          <ConclusionStatusStrip conclusions={conclusions} />
        </div>
      )}
      {!isRunning && !conclusions && stations.length > 0 && (
        <div className="animate-in fade-in flex flex-wrap items-center gap-1.5 duration-200 motion-reduce:animate-none">
          {stations.slice(0, MAX_VISIBLE_STATIONS).map((station) => {
            const isSelected = selection?.messageId === messageId && selection.stationId === station.id;
            return (
              <button
                key={station.id}
                type="button"
                aria-label={`查看 ${station.name} 的依据`}
                aria-pressed={isSelected}
                onClick={() => open(station.id)}
                className={cn(
                  'flex min-h-9 max-w-full items-center gap-2 rounded-full border px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'border-foreground/40 bg-muted',
                )}
              >
                <span className="min-w-0 truncate">{station.name}</span>
                <StationSparkline station={station} />
              </button>
            );
          })}
          {stations.length > MAX_VISIBLE_STATIONS && (
            <button
              type="button"
              onClick={() => setIsExpanded(true)}
              className="flex min-h-9 items-center rounded-full px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              另外 {stations.length - MAX_VISIBLE_STATIONS} 个
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** 还没有任何工具调用时的等待提示；有调查过程后由过程行承担。 */
export const InvestigationIndicator: FC = () => {
  const messageId = useAuiState((state) => state.message.id);
  const hasToolCall = useAuiState((state) => state.message.parts.some((part) => part.type === 'tool-call'));
  if (hasToolCall) return null;
  return (
    <span className="flex items-center gap-2 text-sm">
      <span role="status" className="text-shimmer">正在分析问题…</span>
      <RunElapsed messageId={messageId} />
    </span>
  );
};
