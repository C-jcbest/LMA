import { Children, createContext, isValidElement, useCallback, useContext, useMemo, type ComponentProps, type FC, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownText } from '@/components/markdown-text';
import { cn } from 'cn';
import { cardReferenceFromHref, citedEvidenceIds, evidenceNumbers, insertEvidenceCards, type CardReference } from './evidence-cards';
import { EvidenceCard, hasEvidenceCard, mapContentOf } from './EvidenceCards';
import { buildSteps, collectStations, splitAnswerParts, type InvestigationStep } from './investigation';
import { useStationInspector } from './StationInspectorContext';

const EvidenceContext = createContext<{ steps: InvestigationStep[]; numbers: Map<string, number> }>({ steps: [], numbers: new Map() });

const EvidenceLink: FC<ComponentProps<'a'>> = ({ href, children, ...props }) => {
  const messageId = useAuiState((state) => state.message.id);
  const { steps, numbers } = useContext(EvidenceContext);
  const { openEvidence } = useStationInspector();
  if (cardReferenceFromHref(href) !== null) {
    return null;
  }
  if (!href?.startsWith('#evidence-')) {
    return <a {...props} href={href} className="aui-md-a text-primary underline underline-offset-2">{children}</a>;
  }
  const id = href.slice('#evidence-'.length);
  const citationNumber = numbers.get(id);
  const step = steps.find((item) => item.evidenceId === id && item.state === 'complete');
  if (!step || !citationNumber || (!step.stationId && !step.inlineEnvelope)) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={`查看依据 ${citationNumber}：${step.detail ?? step.label}`}
      className="evidence-citation"
      onClick={() => openEvidence({ messageId, stationId: step.stationId, toolCallId: step.toolCallId })}
    >{citationNumber}</button>
  );
};

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

export const EvidenceMarkdown: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const isRunning = useAuiState((state) => state.message.status?.type === 'running');
  const currentPart = useAuiState((state) => state.part);
  const text = currentPart.type === 'text' ? currentPart.text : '';
  const partIndex = parts.indexOf(currentPart as typeof parts[number]);

  const { foldedIndexes, firstAnswerTextIndex } = useMemo(
    () => splitAnswerParts(parts, isRunning),
    [parts, isRunning],
  );
  const isFolded = partIndex >= 0 && foldedIndexes.has(partIndex);

  const stations = useMemo(() => collectStations(parts), [parts]);
  const steps = useMemo(() => buildSteps(parts, stations), [parts, stations]);
  const visibleTexts = useMemo(
    () => parts.flatMap((part, index) => (part.type === 'text' && !foldedIndexes.has(index) && part.text.trim() ? [{ index, text: part.text }] : [])),
    [parts, foldedIndexes],
  );
  const context = useMemo(() => ({
    steps,
    numbers: evidenceNumbers(visibleTexts.map((item) => item.text).join('\n\n')),
  }), [visibleTexts, steps]);

  const earlierTexts = visibleTexts
    .filter((item) => (partIndex >= 0 ? item.index < partIndex : item.text !== text))
    .map((item) => item.text);
  const cardKey = steps.filter(hasEvidenceCard).map((step) => step.evidenceId).join();
  const alreadyShownKey = earlierTexts.flatMap(citedEvidenceIds).join();
  const isFirstAnswerPart = partIndex >= 0 ? partIndex === firstAnswerTextIndex : earlierTexts.length === 0;
  const includeStationMap = isFirstAnswerPart && mapContentOf(stations, new Map()).stations.length > 0;

  const preprocess = useCallback(
    (markdown: string) => insertEvidenceCards(markdown, {
      cardEvidenceIds: new Set(cardKey.split(',').filter(Boolean)),
      alreadyShown: new Set(alreadyShownKey.split(',').filter(Boolean)),
      includeStationMap,
    }),
    [cardKey, alreadyShownKey, includeStationMap],
  );

  if (isFolded) {
    return null;
  }

  return (
    <EvidenceContext.Provider value={context}>
      <MarkdownText components={components} preprocess={preprocess} />
    </EvidenceContext.Provider>
  );
};
