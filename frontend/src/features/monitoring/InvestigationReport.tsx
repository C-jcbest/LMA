import { useCallback, useMemo, useState, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon, FileTextIcon, Loader2Icon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { MorphIcon } from '@/components/ui/motion-primitives';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from 'cn';
import type { ConclusionsArtifactData } from '@/types/envelope';
import {
  answerToMarkdown,
  collectStations,
  findConclusions,
  investigationStatusLabel,
  STATUS_PRIORITY,
} from './investigation';
import { PrintReport } from './PrintReport';
import { useStationInspector } from './StationInspectorContext';
import { StatusDot } from './status';

const orderedStations = (conclusions: ConclusionsArtifactData) =>
  [...conclusions.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);

const sanitizeFilename = (name: string) =>
  name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export const ConclusionStatusStrip: FC<{ conclusions: ConclusionsArtifactData }> = ({ conclusions }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { selection, openStation, closeInspector } = useStationInspector();
  const stationIds = useMemo(() => new Set(collectStations(parts).map((station) => station.id)), [parts]);

  return (
    <ul aria-label="测点状态" className="flex flex-wrap gap-1.5">
      {orderedStations(conclusions).map((item) => {
        const label = `${item.station_name} ${investigationStatusLabel(item.status)}`;
        const content = (
          <>
            <StatusDot status={item.status} />
            <span className="min-w-0 truncate font-medium">{item.station_name}</span>
            <span className="text-muted-foreground shrink-0">{investigationStatusLabel(item.status)}</span>
          </>
        );
        if (!stationIds.has(item.station_uuid)) {
          return (
            <li
              key={item.station_uuid}
              title={item.reason}
              className="flex min-h-8 max-w-full items-center gap-2 rounded-full bg-muted/60 px-3 text-sm"
            >
              {content}
            </li>
          );
        }
        const isSelected = selection?.messageId === messageId && selection.stationId === item.station_uuid;
        return (
          <li key={item.station_uuid} className="max-w-full">
            <button
              type="button"
              title={item.reason}
              aria-label={`查看 ${label} 的依据`}
              aria-pressed={isSelected}
              onClick={() => (isSelected ? closeInspector() : openStation({ messageId, stationId: item.station_uuid }))}
              className={cn(
                'flex min-h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition hover:bg-muted active:scale-98 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                isSelected && 'border-foreground/40 bg-muted',
              )}
            >
              {content}
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
};

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

export const AnswerActions: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const threadTitle = useAuiState((state) =>
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const markdown = answerToMarkdown(parts);
  const [isPrinting, setIsPrinting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const finishPrinting = useCallback((error = false) => {
    setIsPrinting(false);
    setExportFailed(error);
  }, []);

  const download = () => {
    const filename = sanitizeFilename(threadTitle && threadTitle !== '新会话' ? threadTitle : '') || '调查回答';
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <TooltipIconButton tooltip={isCopied ? '已复制' : '复制'} onClick={() => copyToClipboard(markdown)}>
        <MorphIcon activeKey={isCopied ? 'copied' : 'copy'}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </MorphIcon>
      </TooltipIconButton>
      <TooltipIconButton tooltip="导出为 Markdown" onClick={download}>
        <DownloadIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={isPrinting ? '正在生成 PDF…' : '导出调查 PDF'}
        disabled={isPrinting}
        onClick={() => {
          setExportFailed(false);
          setIsPrinting(true);
        }}
      >
        {isPrinting ? <Loader2Icon className="animate-spin" /> : <FileTextIcon />}
      </TooltipIconButton>
      {exportFailed && <span role="alert" className="text-xs text-destructive">PDF 未能导出，请重试</span>}
      {isPrinting && <PrintReport onDone={finishPrinting} />}
    </>
  );
};
