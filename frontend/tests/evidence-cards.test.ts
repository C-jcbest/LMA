import { describe, expect, it } from 'vitest';
import { CARD_HREF_PREFIX, cardReferenceFromHref, evidenceNumbers, insertEvidenceCards, STATION_MAP_CARD } from '../src/features/monitoring/evidence-cards';

const card = (id: string) => `[依据卡片](${CARD_HREF_PREFIX}${id})`;
const options = (overrides: Partial<Parameters<typeof insertEvidenceCards>[1]> = {}) => ({
  cardEvidenceIds: new Set(['Elong', 'Eshort']),
  alreadyShown: new Set<string>(),
  includeStationMap: false,
  ...overrides,
});

describe('正文依据卡片位置', () => {
  it('依据按首次引用顺序编号，忽略内部 ID、错误数字和重复引用的标签', () => {
    const text = '[E30d8d1](#evidence-E30d8d1) [99](#evidence-Eother)\n\n[2](#evidence-E30d8d1)';
    expect([...evidenceNumbers(text)]).toEqual([['E30d8d1', 1], ['Eother', 2]]);
  });
  it('正文自己列了表格时，紧邻的卡片带上标记，读回时还原编号', () => {
    const markdown = [
      '按 15 天分段的北向变化如下。[1](#evidence-Elong)',
      '| 时段 | 变化 |\n| --- | --- |\n| 10-01 至 10-15 | +1.2 |',
      '近 14 天未见加速。[2](#evidence-Eshort)',
    ].join('\n\n');
    const blocks = insertEvidenceCards(markdown, options()).split('\n\n');
    expect(blocks[1]).toBe(`[依据卡片](${CARD_HREF_PREFIX}Elong?beside-table)`);
    expect(blocks.at(-1)).toBe(card('Eshort'));
    expect(cardReferenceFromHref(`${CARD_HREF_PREFIX}Elong?beside-table`)).toEqual({ cardId: 'Elong', besideTable: true });
    expect(cardReferenceFromHref(`${CARD_HREF_PREFIX}Eshort`)).toEqual({ cardId: 'Eshort', besideTable: false });
  });
  it('卡片跟在第一次引用的段落后，再次引用只保留编号', () => {
    const markdown = [
      '## 一、数据现象',
      '北向净变化约 -11.9 mm。[1](#evidence-Elong)',
      '近 14 天未见加速。[1](#evidence-Elong)[2](#evidence-Eshort)',
    ].join('\n\n');
    expect(insertEvidenceCards(markdown, options()).split('\n\n')).toEqual([
      '## 一、数据现象',
      '北向净变化约 -11.9 mm。[1](#evidence-Elong)',
      card('Elong'),
      '近 14 天未见加速。[1](#evidence-Elong)[2](#evidence-Eshort)',
      card('Eshort'),
    ]);
  });

  it('没有卡片的依据和更早正文已显示的依据不重复插入', () => {
    const markdown = '天气资料暂缺。[3](#evidence-Eweather)\n\n长期趋势延续。[1](#evidence-Elong)';
    const result = insertEvidenceCards(markdown, options({ alreadyShown: new Set(['Elong']) }));
    expect(result).not.toContain(CARD_HREF_PREFIX);
  });

  it('列表的缩进续行结束后才插入卡片，不打断列表项', () => {
    const markdown = '- 北向持续变化 [1](#evidence-Elong)\n\n  该点同组无同步变化\n\n下一段';
    expect(insertEvidenceCards(markdown, options()).split('\n\n')).toEqual([
      '- 北向持续变化 [1](#evidence-Elong)',
      '  该点同组无同步变化',
      card('Elong'),
      '下一段',
    ]);
  });

  it('代码块里的空行不切分段落', () => {
    const markdown = '```\n[1](#evidence-Elong)\n\n仍在代码块\n```\n\n后文';
    const result = insertEvidenceCards(markdown, options());
    expect(result.indexOf(card('Elong'))).toBeGreaterThan(result.indexOf('```\n\n'));
    expect(result).toContain('```\n[1](#evidence-Elong)\n\n仍在代码块\n```');
  });

  it('测点地图放在标题后的第一段正文之后', () => {
    const markdown = '## 调查结论\n\nK3-07 需要人工复核。\n\n## 一、数据现象';
    expect(insertEvidenceCards(markdown, options({ includeStationMap: true })).split('\n\n')).toEqual([
      '## 调查结论',
      'K3-07 需要人工复核。',
      card(STATION_MAP_CARD),
      '## 一、数据现象',
    ]);
  });
});
