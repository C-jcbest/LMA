import { useMemo, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import type { ReportFindingArtifact } from '@/types/envelope';
import {
  buildSteps,
  collectStations,
  findReport,
  groupReportFindings,
  formatSupportFact,
  investigationStatusLabel,
  reportStationDetails,
  answerToMarkdown,
  STATUS_PRIORITY,
} from './investigation';
import { useStationInspector } from './StationInspectorContext';
import { StatusDot } from './status';

const useReportEvidence = () => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { selection, openStation } = useStationInspector();

  return useMemo(() => {
    const stations = collectStations(parts);
    const steps = buildSteps(parts, stations);
    return { messageId, stations, steps, report: findReport(parts), selection, openStation };
  }, [messageId, parts, selection, openStation]);
};

const FindingRow: FC<{
  finding: ReportFindingArtifact;
  citationNumbers: ReadonlyMap<string, number>;
  describe: (toolCallId: string) => string | undefined;
  onOpen: (toolCallId: string) => void;
  canOpen: (toolCallId: string) => boolean;
}> = ({ finding, citationNumbers, describe, onOpen, canOpen }) => (
  <li className="wrap-anywhere">
    {finding.level === 'inference' && <span className="me-2 text-xs text-muted-foreground">推断</span>}
    {finding.text}
    <details className="mt-1 text-sm text-muted-foreground">
      <summary>判断依据说明</summary>
      {finding.supports.map((support, index) => (
        <p key={index}>
          {support.begin_time && support.end_time ? `${support.begin_time} 至 ${support.end_time}` : '场地背景快照'}
          {' · '}{support.rationale}{support.fact && <span> · {formatSupportFact(support.fact)}</span>}
        </p>
      ))}
    </details>
    {finding.evidence.map((toolCallId) => {
      const number = citationNumbers.get(toolCallId);
      const description = describe(toolCallId);
      return canOpen(toolCallId) ? (
        <button
          key={toolCallId}
          type="button"
          title={description}
          aria-label={`查看依据 ${number}：${description ?? ''}`}
          onClick={() => onOpen(toolCallId)}
          className="report-citation text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {number}
        </button>
      ) : (
        <span key={toolCallId} title={description} className="text-muted-foreground ms-1 align-[0.1em] text-xs tabular-nums">
          {number}
        </span>
      );
    })}
  </li>
);

/** 简报先回答哪些点需要看，发现按测点集中呈现，依据跟着结论走。 */
export const InvestigationReport: FC = () => {
  const { messageId, stations, steps, report, selection, openStation } = useReportEvidence();
  if (!report) return null;

  const stationIds = new Set(stations.map((station) => station.id));
  const stepByCall = new Map(steps.map((step) => [step.toolCallId, step]));
  const citationNumbers = new Map<string, number>();
  for (const finding of report.findings) {
    for (const toolCallId of finding.evidence) {
      if (!citationNumbers.has(toolCallId)) {
        citationNumbers.set(toolCallId, citationNumbers.size + 1);
      }
    }
  }

  const describeEvidence = (toolCallId: string) => {
    const step = stepByCall.get(toolCallId);
    return step ? [step.label, step.detail].filter(Boolean).join(' · ') : undefined;
  };
  const canOpenEvidence = (toolCallId: string) => stepByCall.get(toolCallId)?.stationId !== undefined;
  const openEvidence = (toolCallId: string) => {
    const stationId = stepByCall.get(toolCallId)?.stationId;
    if (stationId) {
      openStation({ messageId, stationId, toolCallId });
    }
  };
  const orderedStations = [...report.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
  const { byStation: findingsByStation, shared: sharedFindings } = groupReportFindings(report, steps);
  const quiet = orderedStations.filter((item) => item.status === '未见明显变化');
  const focused = orderedStations.filter((item) => item.status !== '未见明显变化');
  const showAll = report.stations.length === 1;
  const renderFindings = (findings: readonly ReportFindingArtifact[]) => (
    <ul className="report-findings">
      {findings.map((finding, index) => (
        <FindingRow key={index} finding={finding} citationNumbers={citationNumbers} describe={describeEvidence} onOpen={openEvidence} canOpen={canOpenEvidence} />
      ))}
    </ul>
  );
  const renderStation = (item: typeof report.stations[number]) => {
    const details = reportStationDetails(item).join(' · ');
    const isSelected = selection?.messageId === messageId && selection.stationId === item.station_uuid;
    const findings = findingsByStation.get(item.station_uuid) ?? [];
    return (
      <section key={item.station_uuid ?? orderedStations.indexOf(item)} className={cn('report-station', isSelected && 'report-station-selected')}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h3 className="text-base font-semibold">
            {stationIds.has(item.station_uuid) ? (
              <button type="button" aria-label={`查看 ${item.station_name} 的依据`} aria-pressed={isSelected}
                onClick={() => openStation({ messageId, stationId: item.station_uuid })}
                className="focus-visible:ring-ring flex min-h-10 items-center gap-1 rounded-md text-start hover:underline focus-visible:ring-2 focus-visible:outline-none">
                {item.station_name}<ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
              </button>
            ) : <span className="inline-flex min-h-10 items-center">{item.station_name}</span>}
          </h3>
          <span className="text-muted-foreground inline-flex items-center gap-2 text-xs"><StatusDot status={item.status} />{investigationStatusLabel(item.status)}</span>
        </div>
        {item.reason !== report.conclusion && <p className="mb-2 leading-7 wrap-anywhere">{item.reason}</p>}
        {findings.length > 0 && renderFindings(findings)}
        {details && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{details}</p>}
      </section>
    );
  };

  return (
    <section data-slot="investigation-report" aria-label="调查简报" className="investigation-report">
      {report.stations.some((station) => !station.station_uuid) && <p className="mb-3 text-sm text-muted-foreground">历史报告 · 尚未经当前事实契约复核</p>}
      <h2 className="mb-5 text-lg font-semibold leading-7 wrap-anywhere">{report.conclusion}</h2>
      {(showAll ? orderedStations : focused).map(renderStation)}
      {!showAll && quiet.length > 0 && (
        <details className="report-quiet">
          <summary className="cursor-pointer py-3 text-sm text-muted-foreground focus-visible:outline-ring">{quiet.length} 个测点未见明显变化</summary>
          {quiet.map(renderStation)}
        </details>
      )}
      {sharedFindings.length > 0 && (
        <section className="report-shared">
          <h3 className="mb-2 text-base font-semibold">综合判断</h3>
          {renderFindings(sharedFindings)}
        </section>
      )}
      {report.next_steps.length > 0 && (
        <section className="report-next-steps">
          <h3 className="mb-2 text-base font-semibold">建议</h3>
          <ul className="report-findings">{report.next_steps.map((step, index) => <li key={index} className="wrap-anywhere">{step}</li>)}</ul>
        </section>
      )}
    </section>
  );
};

/** 官方复制和导出只读取消息正文，简报需要自己生成文本。 */
export const AnswerActions: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const markdown = answerToMarkdown(parts);

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '调查简报.md';
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
