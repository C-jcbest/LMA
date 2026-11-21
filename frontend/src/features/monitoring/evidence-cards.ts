
export const CARD_HREF_PREFIX = '#evidence-card-';
export const STATION_MAP_CARD = 'station-map';

const CITATION_PATTERN = /\]\(#evidence-([A-Za-z0-9]+)\)/g;
const ECHOED_EVIDENCE_MARKER = /<lma_evidence\b[^>]*\/?>/g;

export const withoutEchoedEvidenceMarkers = (markdown: string) => markdown.replace(ECHOED_EVIDENCE_MARKER, '');
const FENCE_PATTERN = /^\s*(```|~~~)/;

const BESIDE_TABLE_SUFFIX = '?beside-table';
const TABLE_LINE_PATTERN = /^\s*\|/;

const cardMarker = (cardId: string, besideTable: boolean) =>
  `[依据卡片](${CARD_HREF_PREFIX}${cardId}${besideTable ? BESIDE_TABLE_SUFFIX : ''})`;

export interface CardReference {
  cardId: string;
  besideTable: boolean;
}

export const cardReferenceFromHref = (href: string | undefined): CardReference | null => {
  if (!href?.startsWith(CARD_HREF_PREFIX)) {
    return null;
  }
  const marker = href.slice(CARD_HREF_PREFIX.length);
  const besideTable = marker.endsWith(BESIDE_TABLE_SUFFIX);
  return { cardId: besideTable ? marker.slice(0, -BESIDE_TABLE_SUFFIX.length) : marker, besideTable };
};

export function citedEvidenceIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(CITATION_PATTERN)) {
    if (!ids.includes(match[1]!)) {
      ids.push(match[1]!);
    }
  }
  return ids;
}

export const evidenceNumbers = (markdown: string) =>
  new Map(citedEvidenceIds(markdown).map((id, index) => [id, index + 1]));

interface Block {
  lines: string[];
  isHeading: boolean;
  isTable: boolean;
  isContinuation: boolean;
}

function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const first = current[0]!;
    blocks.push({
      lines: current,
      isHeading: /^#{1,6}\s/.test(first),
      isTable: TABLE_LINE_PATTERN.test(first),
      isContinuation: /^[ \t]/.test(first),
    });
    current = [];
  };
  for (const line of markdown.split('\n')) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

interface InsertOptions {
  cardEvidenceIds: ReadonlySet<string>;
  alreadyShown: ReadonlySet<string>;
  includeStationMap: boolean;
}

export function insertEvidenceCards(markdown: string, options: InsertOptions): string {
  const shown = new Set(options.alreadyShown);
  let mapPending = options.includeStationMap;
  let pendingCards: string[] = [];
  const output: string[] = [];
  const blocks = splitBlocks(withoutEchoedEvidenceMarkers(markdown));

  blocks.forEach((block, index) => {
    output.push(block.lines.join('\n'));
    if (mapPending && !block.isHeading) {
      pendingCards.push(STATION_MAP_CARD);
      mapPending = false;
    }
    for (const id of citedEvidenceIds(block.lines.join('\n'))) {
      if (options.cardEvidenceIds.has(id) && !shown.has(id)) {
        shown.add(id);
        pendingCards.push(id);
      }
    }
    const next = blocks[index + 1];
    if (pendingCards.length > 0 && !next?.isContinuation) {
      const besideTable = block.isTable || Boolean(next?.isTable);
      output.push(...pendingCards.map((cardId) => cardMarker(cardId, besideTable)));
      pendingCards = [];
    }
  });
  return output.join('\n\n');
}
