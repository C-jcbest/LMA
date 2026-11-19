import { useEffect, useMemo, useRef, type ComponentProps, type FC } from 'react';
import { createPortal } from 'react-dom';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import * as echarts from 'echarts/core';
import { CustomChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkPointComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { MarkdownText } from '@/components/markdown-text';
import type { GnssArtifactData, ToolArtifactEnvelope } from '@/types/envelope';
import { evidenceNumbers, withoutEchoedEvidenceMarkers } from './evidence-cards';
import { mapContentOf } from './EvidenceCards';
import {
  buildSteps,
  collectStations,
  evidenceDescription,
  findConclusions,
  investigationStatusLabel,
  type InvestigationStep,
  type StationEvidence,
} from './investigation';
import { azimuthOf, directionName } from './map-markers';
import {
  buildTimelineOption,
  dailyRainfallWithin,
  displacementBasis,
  displacementBasisLabel,
  seriesLabel,
  type ChartColors,
} from './timeline';

echarts.use([CustomChart, LineChart, GridComponent, LegendComponent, MarkAreaComponent, MarkPointComponent, SVGRenderer]);

/** 打印固定用浅色：纸面不跟随界面深色主题。数值与设计规范的浅色 Token 一致。 */
const PRINT_COLORS: ChartColors = {
  text: 'hsl(240 10% 8%)',
  mutedText: 'hsl(240 4% 42%)',
  grid: 'hsl(240 6% 90%)',
  surface: 'hsl(0 0% 100%)',
  border: 'hsl(240 6% 85%)',
  primary: 'hsl(240 10% 8%)',
  north: 'hsl(212 86% 46%)',
  east: 'hsl(168 72% 32%)',
  up: 'hsl(22 86% 50%)',
  rain: 'hsl(205 72% 62%)',
  peer: 'hsl(240 4% 74%)',
  gap: 'hsl(240 4% 50% / 0.14)',
};

const STATUS_COLORS: Record<string, string> = {
  需人工复核: 'hsl(2 72% 48%)',
  持续关注: 'hsl(36 92% 46%)',
  未见明显变化: 'hsl(152 60% 36%)',
};
const UNKNOWN_COLOR = 'hsl(240 4% 66%)';

const CHART_WIDTH = 680;
const CHART_HEIGHT = 300;
const CHART_HEIGHT_WITH_RAIN = 340;

const formatTime = (value: Date) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(value);

/** 位移依据的数据截止：最后一个至少有一个方向有效的观测时刻。 */
function lastObservation(data: GnssArtifactData): string | null {
  for (let index = data.points.length - 1; index >= 0; index -= 1) {
    const point = data.points[index]!;
    if (point.n !== null || point.e !== null || point.u !== null) {
      return point.time.slice(0, 16);
    }
  }
  return null;
}

function dataCutoffOf(envelope: ToolArtifactEnvelope): string | null {
  switch (envelope.kind) {
    case 'gnss_series':
      return lastObservation(envelope.data);
    case 'weather':
      return envelope.data.query.history_end_date || null;
    default:
      return null;
  }
}

/** 正文里的引用编号印成方括号数字，与文末依据说明对应；没有对应依据的引用不印。 */
const PrintCitation: FC<ComponentProps<'a'> & { numbers: Map<string, number> }> = ({ href, children, numbers, ...props }) => {
  if (!href?.startsWith('#evidence-')) {
    return <a {...props} href={href}>{children}</a>;
  }
  const number = numbers.get(href.slice('#evidence-'.length));
  return number ? <sup className="print-citation">[{number}]</sup> : null;
};

const PrintSeriesChart: FC<{ station: StationEvidence | undefined; data: GnssArtifactData }> = ({ station, data }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rainfall = useMemo(
    () => dailyRainfallWithin((station?.weather ?? []).map((item) => item.data), data.begin_time, data.end_time),
    [station, data],
  );
  const height = rainfall.length > 0 ? CHART_HEIGHT_WITH_RAIN : CHART_HEIGHT;

  useEffect(() => {
    const chart = echarts.init(containerRef.current!, undefined, { renderer: 'svg', width: CHART_WIDTH, height });
    const { dataZoom, brush, toolbox, tooltip, ...option } = buildTimelineOption(
      { data, rainfall, peers: [], mode: 'components' }, PRINT_COLORS,
    ) as Record<string, unknown>;
    const hasRainfall = rainfall.length > 0;
    chart.setOption({
      ...option,
      grid: hasRainfall
        ? [{ left: 48, right: 12, top: 40, bottom: 120 }, { left: 48, right: 12, height: 60, bottom: 28 }]
        : [{ left: 48, right: 12, top: 40, bottom: 28 }],
    });
    return () => chart.dispose();
  }, [data, rainfall, height]);

  return <div ref={containerRef} style={{ width: CHART_WIDTH, height }} />;
};

/** 测点位置示意：只画点位、状态色与水平位移方向，不依赖地图底图，打印稳定。 */
const PrintStationMap: FC<{ stations: readonly StationEvidence[]; conclusions: ReadonlyMap<string, { status: string; reason: string }> }> = ({ stations, conclusions }) => {
  const { stations: located, references } = mapContentOf(stations, conclusions);
  if (located.length === 0) {
    return null;
  }
  const width = CHART_WIDTH;
  const height = 300;
  const padding = 60;
  const all = [...located, ...references];
  const latitude0 = all.reduce((sum, station) => sum + station.latitude, 0) / all.length;
  const scaleX = Math.cos((latitude0 * Math.PI) / 180);
  const xs = all.map((station) => station.longitude * scaleX);
  const ys = all.map((station) => station.latitude);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1e-4;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1e-4;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const project = (station: { latitude: number; longitude: number }) => ({
    x: width / 2 + (station.longitude * scaleX - (Math.min(...xs) + spanX / 2)) * scale,
    y: height / 2 - (station.latitude - (Math.min(...ys) + spanY / 2)) * scale,
  });
  const largest = Math.max(1e-6, ...located.map((station) => Math.hypot(station.northMillimeters ?? 0, station.eastMillimeters ?? 0)));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="测点位置与水平位移方向示意">
      <defs>
        <marker id="print-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={PRINT_COLORS.text} />
        </marker>
      </defs>
      <rect x="0.5" y="0.5" width={width - 1} height={height - 1} fill="none" stroke={PRINT_COLORS.border} />
      <text x={width - 14} y={22} textAnchor="end" fontSize="11" fill={PRINT_COLORS.mutedText}>北 ↑</text>
      {references.map((station) => {
        const { x, y } = project(station);
        return (
          <g key={station.id}>
            <circle cx={x} cy={y} r={4} fill={UNKNOWN_COLOR} />
            <text x={x + 8} y={y + 4} fontSize="11" fill={PRINT_COLORS.mutedText}>{station.name}</text>
          </g>
        );
      })}
      {located.map((station) => {
        const { x, y } = project(station);
        const color = (station.status && STATUS_COLORS[station.status]) || UNKNOWN_COLOR;
        const hasArrow = station.stationType !== '基准站' && station.northMillimeters !== null && station.eastMillimeters !== null
          && Math.hypot(station.northMillimeters, station.eastMillimeters) > 0;
        let arrow = null;
        if (hasArrow) {
          const magnitude = Math.hypot(station.northMillimeters!, station.eastMillimeters!);
          const length = 18 + 42 * (magnitude / largest);
          const azimuth = azimuthOf(station.northMillimeters!, station.eastMillimeters!);
          const radians = (azimuth * Math.PI) / 180;
          arrow = (
            <>
              <line x1={x} y1={y} x2={x + Math.sin(radians) * length} y2={y - Math.cos(radians) * length}
                stroke={PRINT_COLORS.text} strokeWidth="1.6" markerEnd="url(#print-arrow)" />
              <text x={x + 8} y={y + 18} fontSize="10" fill={PRINT_COLORS.mutedText}>
                {`${magnitude.toFixed(1)} mm · ${directionName(azimuth)}`}
              </text>
            </>
          );
        }
        return (
          <g key={station.id}>
            {arrow}
            <circle cx={x} cy={y} r={6} fill={color} stroke="#fff" strokeWidth="1.5" />
            <text x={x + 9} y={y + 4} fontSize="12" fontWeight="600" fill={PRINT_COLORS.text}>{station.name}</text>
          </g>
        );
      })}
    </svg>
  );
};

interface Figure {
  number: number;
  step: InvestigationStep;
  data: GnssArtifactData;
}

/**
 * 可打印的调查材料：结论、正文、附图与依据说明。只读本条回答已有的依据，不重新取数；
 * 不印调查过程、逐点数据、计算代码和交互控件。渲染完成后调用浏览器打印，可另存为 PDF。
 */
const PrintReportContent: FC<{ onDone: () => void }> = ({ onDone }) => {
  const parts = useAuiState((state) => state.message.parts);
  const createdAt = useAuiState((state) => state.message.createdAt);
  const title = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.title);
  const stations = useMemo(() => collectStations(parts), [parts]);
  const steps = useMemo(() => buildSteps(parts, stations), [parts, stations]);
  const conclusions = findConclusions(parts);
  const text = withoutEchoedEvidenceMarkers(parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n'));
  const numbers = useMemo(() => evidenceNumbers(text), [text]);
  const conclusionsByStation = useMemo(
    () => new Map((conclusions?.stations ?? []).map((item) => [item.station_uuid, { status: item.status, reason: item.reason }])),
    [conclusions],
  );

  const cited = [...numbers]
    .map(([id, number]) => ({ number, step: steps.find((step) => step.evidenceId === id) }))
    .filter((item): item is { number: number; step: InvestigationStep } => Boolean(item.step?.envelope));
  const figures: Figure[] = cited.flatMap(({ number, step }) => (
    step.envelope?.kind === 'gnss_series' && step.state === 'complete' ? [{ number, step, data: step.envelope.data }] : []
  ));
  const cutoffs = cited.flatMap(({ step }) => {
    const cutoff = dataCutoffOf(step.envelope!);
    return cutoff ? [cutoff] : [];
  }).sort();
  const dataCutoff = cutoffs.at(-1);

  useEffect(() => {
    // 等正文与图表完成一次绘制再打开打印对话框。
    const timer = window.setTimeout(() => {
      const finish = () => {
        window.removeEventListener('afterprint', finish);
        onDone();
      };
      window.addEventListener('afterprint', finish);
      window.print();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  const citationComponents = useMemo(() => ({
    a: (props: ComponentProps<'a'>) => <PrintCitation {...props} numbers={numbers} />,
  }), [numbers]);

  return (
    <article className="print-report-body">
      <header className="print-report-header">
        <h1>{title || '调查材料'}</h1>
        <dl>
          {dataCutoff && <><dt>数据截止</dt><dd>{dataCutoff}</dd></>}
          {createdAt && <><dt>回答生成</dt><dd>{formatTime(new Date(createdAt))}</dd></>}
          <dt>打印</dt><dd>{formatTime(new Date())}</dd>
        </dl>
        {conclusions && conclusions.stations.length > 0 && (
          <ul className="print-report-status">
            {conclusions.stations.map((item) => (
              <li key={item.station_uuid}>
                <span className="print-dot" style={{ background: STATUS_COLORS[item.status] ?? UNKNOWN_COLOR }} />
                <b>{item.station_name}</b>　{investigationStatusLabel(item.status)}
                {item.begin_time && item.end_time && <span className="print-muted">　{item.begin_time.slice(0, 10)} 至 {item.end_time.slice(0, 10)}</span>}
              </li>
            ))}
          </ul>
        )}
      </header>

      <section className="print-report-text">
        <MessagePrimitive.Parts components={{
          Text: () => <MarkdownText components={citationComponents} preprocess={withoutEchoedEvidenceMarkers} defer={false} />,
          tools: { Fallback: () => null },
        }} />
      </section>

      {(figures.length > 0 || stations.some((station) => station.coordinates)) && (
        <section className="print-report-figures">
          <h2>附图</h2>
          {stations.some((station) => station.coordinates) && (
            <figure>
              <PrintStationMap stations={stations} conclusions={conclusionsByStation} />
              <figcaption>测点位置与最新水平位移方向示意（北向上，箭头长度为相对示意，灰点为同组测点）。</figcaption>
            </figure>
          )}
          {figures.map(({ number, step, data }) => (
            <figure key={step.toolCallId}>
              <PrintSeriesChart station={stations.find((station) => station.id === step.stationId)} data={data} />
              <figcaption>
                依据 [{number}]　{data.station_name}　{seriesLabel(data)}；
                {displacementBasis(data) === 'fixed' ? '相对平台固定参考的累计位移' : displacementBasisLabel(data)}
                {data.summary.gaps.length > 0 ? `；缺测 ${data.summary.gaps.length} 段` : ''}
                {lastObservation(data) ? `；最后观测 ${lastObservation(data)}` : ''}。
              </figcaption>
            </figure>
          ))}
        </section>
      )}

      {cited.length > 0 && (
        <section className="print-report-evidence">
          <h2>依据说明</h2>
          <ol>
            {cited.map(({ number, step }) => {
              const envelope = step.envelope!;
              const sources = (envelope.sources ?? []).map((source) => source.name || source.provider).filter(Boolean);
              return (
                <li key={step.toolCallId} value={number}>
                  <p>{evidenceDescription(step)}</p>
                  {sources.length > 0 && <p className="print-muted">来源：{sources.join('、')}</p>}
                  {(envelope.limitations ?? []).map((limitation) => <p key={limitation} className="print-muted">{limitation}</p>)}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </article>
  );
};

/** 打印内容挂在 body 下；屏幕上移出视口，打印时只显示它。 */
export const PrintReport: FC<{ onDone: () => void }> = ({ onDone }) => createPortal(
  <div className="print-report" aria-hidden>
    <PrintReportContent onDone={onDone} />
  </div>,
  document.body,
);
