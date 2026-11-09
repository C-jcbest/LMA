import { useMemo, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import type { InvestigationStatus, ReportFindingArtifact } from '@/types/envelope';
import { StationSparkline } from './InvestigationProcess';
import {
  buildSteps,
  collectStations,
  FINDING_LEVELS,
  findingHeading,
  findReport,
  reportToMarkdown,
  STATUS_PRIORITY,
} from './investigation';
import { useStationInspector } from './StationInspectorContext';

const STATUS_DOT_CLASS: Record<InvestigationStatus, string> = {
  需人工复核: 'bg-status-critical',
  持续关注: 'bg-status-attention',
  数据不足: 'bg-status-unknown',
  暂无法分析: 'bg-status-unknown',
  未见明显变化: 'bg-status-normal',
};

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
  <li className="wrap-break-word">
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
    <section data-slot="investigation-report" aria-label="调查简报" className="space-y-5">
      <p className="text-lg leading-snug font-medium wrap-break-word">{report.conclusion}</p>

      <ul className="divide-y rounded-lg border">
        {orderedStations.map((item) => {
          const evidence = stations.find((station) => station.name === item.station_name);
          const isSelected = selection?.messageId === messageId && selection.stationName === item.station_name;
          const content = (
            <>
              <span className="flex items-center gap-2">
                <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[item.status])} aria-hidden />
                <span className="min-w-0 truncate font-medium">{item.station_name}</span>
                <span className="text-muted-foreground shrink-0 text-sm">{item.status}</span>
                {evidence && <span className="ms-auto"><StationSparkline station={evidence} /></span>}
              </span>
              <span className="mt-1 block text-sm wrap-break-word">{item.reason}</span>
              <span className="text-muted-foreground mt-0.5 block text-sm wrap-break-word">
                {item.acceleration} · {item.data_quality}
              </span>
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
                    'focus-visible:ring-ring block w-full px-3.5 py-2.5 text-start transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/60 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
                    isSelected && 'bg-muted',
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className="px-3.5 py-2.5">{content}</div>
              )}
            </li>
          );
        })}
      </ul>

      {FINDING_LEVELS.map((level) => {
        const findings = report.findings.filter((finding) => finding.level === level);
        if (findings.length === 0) return null;
        return (
          <div key={level}>
            <h3 className="text-muted-foreground mb-1.5 text-sm font-medium">{findingHeading(level)}</h3>
            <ul className={cn('space-y-1.5', level === 'inference' && 'border-status-attention border-s-2 ps-3')}>
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
        <div>
          <h3 className="text-muted-foreground mb-1.5 text-sm font-medium">建议</h3>
          <ul className="space-y-1.5">
            {report.next_steps.map((step, index) => <li key={index} className="wrap-break-word">{step}</li>)}
          </ul>
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
