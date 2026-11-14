import { Children, createContext, isValidElement, useCallback, useContext, useMemo, type ComponentProps, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownText } from '@/components/markdown-text';
import { cn } from '@/lib/utils';
import { cardReferenceFromHref, citedEvidenceIds, evidenceNumbers, insertEvidenceCards, type CardReference } from './evidence-cards';
import { EvidenceCard, hasEvidenceCard, mapContentOf } from './EvidenceCards';
import { buildSteps, collectStations, type InvestigationStep } from './investigation';
import { useStationInspector } from './StationInspectorContext';
import { FOCUS_EVIDENCE_EVENT, timelineCardId, type FocusEvidenceDetail } from './StationTimelineCard';

const SERIES_KINDS = new Set(['gnss_series', 'station_overview']);

const EvidenceContext = createContext<{ steps: InvestigationStep[]; numbers: Map<string, number> }>({ steps: [], numbers: new Map() });

const EvidenceLink: FC<ComponentProps<'a'>> = ({ href, children, ...props }) => {
  const messageId = useAuiState((state) => state.message.id);
  const { steps, numbers } = useContext(EvidenceContext);
  const { openEvidence } = useStationInspector();
  if (cardReferenceFromHref(href) !== null) {
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
  const open = () => {
    // 位移依据已在正文里合成测点时间轴卡：滚动过去并切到这个窗口；卡片不在页面上时再打开依据面板。
    const stationId = step.stationId;
    const isSeries = step.envelope !== undefined && SERIES_KINDS.has(step.envelope.kind);
    if (isSeries && stationId && document.getElementById(timelineCardId(messageId, stationId))) {
      const detail: FocusEvidenceDetail = { messageId, stationId, toolCallId: step.toolCallId };
      window.dispatchEvent(new CustomEvent(FOCUS_EVIDENCE_EVENT, { detail }));
      return;
    }
    openEvidence({ messageId, stationId, toolCallId: step.toolCallId });
  };
  return (
    <button
      type="button"
      aria-label={`查看依据 ${citationNumber}：${step.detail ?? step.label}`}
      className="evidence-citation"
      onClick={open}
    >{citationNumber}</button>
  );
};

/** 预处理插入的卡片标记独占一段，渲染为卡片而不是段落。 */
const cardReferenceOfParagraph = (children: ReactNode): CardReference | null => {
  const nodes = Children.toArray(children);
  if (nodes.length !== 1 || !isValidElement<{ href?: string }>(nodes[0])) {
    return null;
  }
  return cardReferenceFromHref(nodes[0].props.href);
};

const Paragraph: FC<ComponentProps<'p'>> = ({ className, children, ...props }) => {
  const card = cardReferenceOfParagraph(children);
  if (card !== null) {
    return <EvidenceCard cardId={card.cardId} besideTable={card.besideTable} />;
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
  const includeStationMap = earlierTexts.length === 0 && mapContentOf(stations, new Map()).stations.length > 0;

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
