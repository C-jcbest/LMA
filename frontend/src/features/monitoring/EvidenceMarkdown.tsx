import { Children, createContext, isValidElement, useCallback, useContext, useMemo, useState, type ComponentProps, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownText } from '@/components/markdown-text';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { cardIdFromHref, citedEvidenceIds, evidenceNumbers, insertEvidenceCards } from './evidence-cards';
import { EvidenceCard, hasEvidenceCard, mapStationsOf } from './EvidenceCards';
import { buildSteps, collectStations, type InvestigationStep } from './investigation';
import { StepInlineResult } from './InvestigationProcess';
import { useStationInspector } from './StationInspectorContext';

const EvidenceContext = createContext<{ steps: InvestigationStep[]; numbers: Map<string, number> }>({ steps: [], numbers: new Map() });

const EvidenceLink: FC<ComponentProps<'a'>> = ({ href, children, ...props }) => {
  const messageId = useAuiState((state) => state.message.id);
  const { steps, numbers } = useContext(EvidenceContext);
  const { openStation } = useStationInspector();
  const [expanded, setExpanded] = useState(false);
  if (cardIdFromHref(href) !== null) {
    // 卡片标记只应独占一段，由段落组件渲染；混在句中时不显示。
    return null;
  }
  if (!href?.startsWith('#evidence-')) {
    return <a {...props} href={href} className="aui-md-a text-primary underline underline-offset-2">{children}</a>;
  }
  const id = href.slice('#evidence-'.length);
  const citationNumber = numbers.get(id);
  const step = steps.find((item) => item.evidenceId === id && item.state === 'complete');
  // 不存在或尚未收到的依据不生成跳转，避免暴露内部编号和伪造引用。
  if (!step || !citationNumber || (!step.stationId && !step.inlineEnvelope)) {
    return <span className="text-muted-foreground text-xs" title="原始依据未随本次结果提供">依据暂缺</span>;
  }
  return (
    <>
      <button
        type="button"
        aria-label={`查看依据 ${citationNumber}：${step.detail ?? step.label}`}
        className="evidence-citation"
        onClick={() => {
          if (step.stationId) {
            openStation({ messageId, stationId: step.stationId, toolCallId: step.toolCallId });
          } else {
            setExpanded(true);
          }
        }}
      >{citationNumber}</button>
      {!step.stationId && (
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

/** 预处理插入的卡片标记独占一段，渲染为卡片而不是段落。 */
const cardIdOfParagraph = (children: ReactNode): string | null => {
  const nodes = Children.toArray(children);
  if (nodes.length !== 1 || !isValidElement<{ href?: string }>(nodes[0])) {
    return null;
  }
  return cardIdFromHref(nodes[0].props.href);
};

const Paragraph: FC<ComponentProps<'p'>> = ({ className, children, ...props }) => {
  const cardId = cardIdOfParagraph(children);
  if (cardId !== null) {
    return <EvidenceCard cardId={cardId} />;
  }
  return <p className={cn('aui-md-p my-4 leading-7 first:mt-0 last:mb-0', className)} {...props}>{children}</p>;
};

const components = { a: EvidenceLink, p: Paragraph };

/**
 * 正文按依据第一次被引用的位置插入曲线、地图等卡片。
 * 一条回答可能有多段正文（工具调用前后各一段），更早段落已显示的卡片不再重复。
 */
export const EvidenceMarkdown: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const text = useAuiState((state) => (state.part.type === 'text' ? state.part.text : ''));
  const stations = useMemo(() => collectStations(parts), [parts]);
  const steps = useMemo(() => buildSteps(parts, stations), [parts, stations]);
  const context = useMemo(() => ({
    steps,
    numbers: evidenceNumbers(parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n')),
  }), [parts, steps]);

  const textParts = parts.flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text] : []));
  const earlierTexts = textParts.slice(0, Math.max(0, textParts.indexOf(text)));
  const cardKey = steps.filter(hasEvidenceCard).map((step) => step.evidenceId).join();
  const alreadyShownKey = earlierTexts.flatMap(citedEvidenceIds).join();
  const includeStationMap = earlierTexts.length === 0 && mapStationsOf(stations, new Map()).length > 0;

  const preprocess = useCallback(
    (markdown: string) => insertEvidenceCards(markdown, {
      cardEvidenceIds: new Set(cardKey.split(',').filter(Boolean)),
      alreadyShown: new Set(alreadyShownKey.split(',').filter(Boolean)),
      includeStationMap,
    }),
    [cardKey, alreadyShownKey, includeStationMap],
  );

  return (
    <EvidenceContext.Provider value={context}>
      <MarkdownText components={components} preprocess={preprocess} />
    </EvidenceContext.Provider>
  );
};
