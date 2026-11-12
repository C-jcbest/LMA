/**
 * 证据卡片在正文中的位置：依据第一次被引用的段落之后显示一次，同一依据后续只保留引用编号。
 * 位置由前端按引用决定，模型只需在支持结论的句末标注依据。
 */

export const CARD_HREF_PREFIX = '#evidence-card-';
export const STATION_MAP_CARD = 'station-map';

const CITATION_PATTERN = /\]\(#evidence-([A-Za-z0-9]+)\)/g;
const FENCE_PATTERN = /^\s*(```|~~~)/;

const cardMarker = (cardId: string) => `[依据卡片](${CARD_HREF_PREFIX}${cardId})`;

export const cardIdFromHref = (href: string | undefined): string | null =>
  href?.startsWith(CARD_HREF_PREFIX) ? href.slice(CARD_HREF_PREFIX.length) : null;

/** 依次返回正文引用的依据编号，重复引用只记第一次。 */
export function citedEvidenceIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(CITATION_PATTERN)) {
    if (!ids.includes(match[1]!)) {
      ids.push(match[1]!);
    }
  }
  return ids;
}

/** 显示和导出共用首次引用的顺序，模型给出的标签不决定用户看到的编号。 */
export const evidenceNumbers = (markdown: string) =>
  new Map(citedEvidenceIds(markdown).map((id, index) => [id, index + 1]));

interface Block {
  lines: string[];
  isHeading: boolean;
  /** 缩进开头的块属于上一列表项，卡片不能插在它和列表之间。 */
  isContinuation: boolean;
}

/** 按空行切分顶层块；代码块内部的空行不切分。 */
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
  /** 有卡片可显示的依据编号；其余引用只保留编号。 */
  cardEvidenceIds: ReadonlySet<string>;
  /** 本条回答更早的正文已经显示过卡片的依据。 */
  alreadyShown: ReadonlySet<string>;
  /** 是否在第一段正文后显示测点地图。 */
  includeStationMap: boolean;
}

export function insertEvidenceCards(markdown: string, options: InsertOptions): string {
  const shown = new Set(options.alreadyShown);
  let mapPending = options.includeStationMap;
  let pendingCards: string[] = [];
  const output: string[] = [];
  const blocks = splitBlocks(markdown);

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
      output.push(...pendingCards.map(cardMarker));
      pendingCards = [];
    }
  });
  return output.join('\n\n');
}
