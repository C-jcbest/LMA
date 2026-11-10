import { useMemo, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import type { ReportFindingArtifact } from '@/types/envelope';
import { StationSparkline } from './InvestigationProcess';
import {
  buildSteps,
  collectStations,
  FINDING_LEVELS,
  findingHeading,
  findReport,
  investigationStatusLabel,
  reportStationDetails,
  reportToMarkdown,
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
    {finding.text}
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
          className="bg-muted text-muted-foreground hover:text-foreground focus-visible:ring-ring ms-1 inline-flex size-[1.125rem] items-center justify-center rounded-full align-[0.1em] text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
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

/** 简报先回答哪些点需要看，事实、分析和推断分开呈现，依据跟着结论走。 */
export const InvestigationReport: FC = () => {
  const { messageId, stations, steps, report, selection, openStation } = useReportEvidence();
  if (!report) return null;

  const stationNames = new Set(stations.map((station) => station.name));
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
  const canOpenEvidence = (toolCallId: string) => stepByCall.get(toolCallId)?.stationName !== undefined;
  const openEvidence = (toolCallId: string) => {
    const stationName = stepByCall.get(toolCallId)?.stationName;
    if (stationName) {
      openStation({ messageId, stationName, toolCallId });
    }
  };
  const orderedStations = [...report.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);

  return (
    <section data-slot="investigation-report" aria-label="调查简报" className="investigation-report">
      <header className="report-summary">
        <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">调查简报 · {report.stations.length} 个测点</p>
        <h2 className="text-lg leading-relaxed font-semibold wrap-anywhere sm:text-xl">{report.conclusion}</h2>
      </header>

      <ul className="report-stations divide-y overflow-hidden rounded-xl border">
        {orderedStations.map((item) => {
          const evidence = stations.find((station) => station.name === item.station_name);
          const isSelected = selection?.messageId === messageId && selection.stationName === item.station_name;
          const details = reportStationDetails(item).join(' · ');
          const content = (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <StatusDot status={item.status} />
                <span className="min-w-0 wrap-anywhere font-semibold">{item.station_name}</span>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs">{investigationStatusLabel(item.status)}</span>
                {evidence && <span className="ms-auto"><StationSparkline station={evidence} /></span>}
              </span>
              <span className="mt-2 block text-sm leading-relaxed wrap-anywhere">{item.reason}</span>
              {details && <span className="text-muted-foreground mt-1 block text-xs leading-relaxed wrap-anywhere">{details}</span>}
            </>
          );
          return (
            <li key={item.station_name}>
              {stationNames.has(item.station_name) ? (
                <button
                  type="button"
                  aria-label={`查看 ${item.station_name} 的依据`}
                  aria-pressed={isSelected}
                  onClick={() => openStation({ messageId, stationName: item.station_name })}
                  className={cn(
                    'focus-visible:ring-ring block w-full p-4 text-start transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
                    isSelected && 'bg-muted',
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className="p-4">{content}</div>
              )}
            </li>
          );
        })}
      </ul>

      {FINDING_LEVELS.map((level) => {
        const findings = report.findings.filter((finding) => finding.level === level);
        if (findings.length === 0) return null;
        return (
          <div key={level} className="report-section">
            <h3>{findingHeading(level)}</h3>
            <ul className="report-findings">
              {findings.map((finding, index) => (
                <FindingRow
                  key={index}
                  finding={finding}
                  citationNumbers={citationNumbers}
                  describe={describeEvidence}
                  onOpen={openEvidence}
                  canOpen={canOpenEvidence}
                />
              ))}
            </ul>
          </div>
        );
      })}

      {report.next_steps.length > 0 && (
        <div className="report-section report-next-steps">
          <h3>建议</h3>
          <ol className="report-findings list-decimal">
            {report.next_steps.map((step, index) => <li key={index} className="wrap-anywhere">{step}</li>)}
          </ol>
        </div>
      )}
    </section>
  );
};

/** 官方复制和导出只读取消息正文，简报需要自己生成文本。 */
export const ReportActions: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const report = findReport(parts);
  if (!report) return null;
  const markdown = reportToMarkdown(report);

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
