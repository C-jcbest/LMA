import { useMemo, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { TooltipIconButton } from '@/components/tooltip-icon-button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import type { ConclusionsArtifactData } from '@/types/envelope';
import {
  answerToMarkdown,
  collectStations,
  findConclusions,
  investigationStatusLabel,
  STATUS_PRIORITY,
} from './investigation';
import { useStationInspector } from './StationInspectorContext';
import { StatusDot } from './status';

const orderedStations = (conclusions: ConclusionsArtifactData) =>
  [...conclusions.stations].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);

/**
 * 结论登记是留档数据，正文才是回答：页面只用一行标签给出各测点状态，点击打开该测点依据。
 * 原因写在标签提示里，避免和正文重复。
 */
export const ConclusionStatusStrip: FC<{ conclusions: ConclusionsArtifactData }> = ({ conclusions }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { selection, openStation } = useStationInspector();
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
        const chipClass = 'flex min-h-8 max-w-full items-center gap-2 rounded-full border px-3 text-sm';
        if (!stationIds.has(item.station_uuid)) {
          return <li key={item.station_uuid} className={chipClass} title={item.reason}>{content}</li>;
        }
        const isSelected = selection?.messageId === messageId && selection.stationId === item.station_uuid;
        return (
          <li key={item.station_uuid} className="max-w-full">
            <button
              type="button"
              title={item.reason}
              aria-label={`查看 ${label} 的依据`}
              aria-pressed={isSelected}
              onClick={() => openStation({ messageId, stationId: item.station_uuid })}
              className={cn(
                chipClass,
                'transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                isSelected && 'border-foreground/40 bg-muted',
              )}
            >
              {content}
            </button>
          </li>
        );
      })}
    </ul>
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
