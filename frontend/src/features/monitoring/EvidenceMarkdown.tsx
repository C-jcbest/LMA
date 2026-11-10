import { useMemo, useState, type ComponentProps, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownText } from '@/components/markdown-text';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { buildSteps, collectStations } from './investigation';
import { StepInlineResult } from './InvestigationProcess';
import { useStationInspector } from './StationInspectorContext';

const EvidenceLink: FC<ComponentProps<'a'>> = ({ href, children, ...props }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState((state) => state.message.parts);
  const { openStation } = useStationInspector();
  const [expanded, setExpanded] = useState(false);
  const steps = useMemo(() => buildSteps(parts, collectStations(parts)), [parts]);
  if (!href?.startsWith('#evidence-')) {
    return <a {...props} href={href} className="aui-md-a text-primary underline underline-offset-2">{children}</a>;
  }
  const id = href.slice('#evidence-'.length);
  const step = steps.find((item) => item.evidenceId === id && item.state === 'complete');
  // 不存在或尚未收到的依据不生成跳转，避免暴露内部编号和伪造引用。
  if (!step || (!step.stationName && !step.inlineEnvelope)) {
    return <span className="text-muted-foreground text-xs">{children}</span>;
  }
  return (
    <>
      <button
        type="button"
        aria-label={`查看依据 ${children}：${step.detail ?? step.label}`}
        className="report-citation text-muted-foreground hover:text-foreground inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-xs tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => {
          if (step.stationName) {
            openStation({ messageId, stationName: step.stationName, toolCallId: step.toolCallId });
          } else {
            setExpanded(true);
          }
        }}
      >{children}</button>
      {!step.stationName && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogTitle>{step.detail ?? step.label}</DialogTitle>
            <DialogDescription className="sr-only">该引用对应的查询结果</DialogDescription>
            <StepInlineResult step={step} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

const components = { a: EvidenceLink };
export const EvidenceMarkdown: FC = () => <MarkdownText components={components} />;
