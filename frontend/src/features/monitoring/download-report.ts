const MARGIN_MM = 15;
const CONTENT_WIDTH_MM = 180;
const CONTENT_HEIGHT_MM = 267;

function pageBreaks(report: HTMLElement, pageHeight: number): number[] {
  const top = report.getBoundingClientRect().top;
  const height = Math.ceil(report.getBoundingClientRect().height);
  const breaks = new Set<number>([height]);
  const addBreak = (bottom: number) => breaks.add(Math.ceil(bottom - top));
  for (const block of report.querySelectorAll('header, figure, ol > li, .aui-md p, .aui-md li, .aui-md tr, .aui-md pre')) {
    if (block.closest('header, figure') !== null && !block.matches('header, figure')) continue;
    addBreak(block.getBoundingClientRect().bottom);
    if (!block.matches('.aui-md p, .aui-md li')) continue;
    const range = document.createRange();
    range.selectNodeContents(block);
    for (const line of range.getClientRects()) {
      addBreak(line.bottom);
    }
  }
  const candidates = [...breaks].sort((a, b) => a - b);
  const pages: number[] = [0];
  while (pages[pages.length - 1]! < height) {
    const start = pages[pages.length - 1]!;
    const limit = Math.min(start + pageHeight, height);
    const fitting = candidates.filter((candidate) => candidate > start && candidate <= limit);
    pages.push(fitting.at(-1) ?? limit);
  }
  return pages;
}

export async function downloadReport(report: HTMLElement, signal: AbortSignal) {
  const [{ jsPDF }, { default: capture }] = await Promise.all([import('jspdf'), import('html2canvas-pro')]);
  await document.fonts.ready;
  if (signal.aborted) return;
  const width = Math.ceil(report.getBoundingClientRect().width);
  const pages = pageBreaks(report, Math.floor(width * CONTENT_HEIGHT_MM / CONTENT_WIDTH_MM));
  const pdf = new jsPDF({ format: 'a4', compress: true });
  for (let index = 1; index < pages.length; index += 1) {
    const y = pages[index - 1]!;
    const height = pages[index]! - y;
    const canvas = await capture(report, {
      y, width, height, scale: 2, backgroundColor: '#fff', windowWidth: 900,
    });
    if (signal.aborted) return;
    if (index > 1) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', MARGIN_MM, MARGIN_MM, CONTENT_WIDTH_MM, height * CONTENT_WIDTH_MM / width, undefined, 'FAST');
    canvas.width = 0;
    canvas.height = 0;
  }
  pdf.save('调查材料.pdf');
}
