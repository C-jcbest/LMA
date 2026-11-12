import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { CustomChart, LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkPointComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { XIcon, ZoomInIcon } from 'lucide-react';

echarts.use([
  CustomChart,
  LineChart,
  AxisPointerComponent,
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkPointComponent,
  // 拖选依赖 brush，而 brush 内部需要 toolbox 组件，界面上不显示工具栏。
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface ChartRange {
  start: number;
  end: number;
}

interface TimelineChartProps {
  viewKey: string;
  option: echarts.EChartsCoreOption;
  label: string;
  resetSignal: number;
  onRangeChange: (range: ChartRange | null) => void;
  /** 把一段时间带入追问；不传时不显示就地追问按钮。 */
  onAsk?: (range: ChartRange) => void;
  askDisabled?: boolean;
}

interface SliderState {
  type?: string;
  start: number;
  end: number;
  startValue: number;
  endValue: number;
}

interface BrushEndEvent {
  areas: { coordRange?: [number, number] }[];
}

interface AxisPointerEvent {
  axesInfo?: { axisDim: string; value: number }[];
}

const FULL_RANGE_TOLERANCE = 0.01;
const DAY_MILLIS = 86400e3;
/** 追问按钮放在图例与绘图区之间的空白带，不压在曲线上。 */
const ASK_BAR_TOP = 18;
const ASK_BAR_HALF_WIDTH = 64;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 12;

/** 有指针时拖选；触屏上拖动留给页面滚动，用底部滑块缩放。 */
const enableDragSelection = (chart: echarts.ECharts) => {
  if (!window.matchMedia('(hover: hover)').matches) return;
  chart.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'lineX', brushMode: 'single' },
  });
};

/** 悬停所在的那一天（本地时区，与图表解析时间的方式一致）。 */
const dayAround = (time: number): ChartRange => {
  const start = new Date(time);
  start.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: start.getTime() + DAY_MILLIS };
};

const formatDay = (time: number) => {
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const ASK_BUTTON_CLASS = 'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';

export default function TimelineChart({ viewKey, option, label, resetSignal, onRangeChange, onAsk, askDisabled = false }: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const previousViewRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  // 悬停时刻与拖选范围只存时间值，按钮位置在渲染时由图表换算，缩放或改尺寸后不会错位。
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [selection, setSelection] = useState<ChartRange | null>(null);
  const isSelectingRef = useRef(false);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  const clearSelection = () => {
    chartRef.current?.dispatchAction({ type: 'brush', areas: [] });
    setSelection(null);
  };

  useEffect(() => {
    const container = containerRef.current!;
    const initializeChart = () => {
      if (chartRef.current || container.clientWidth <= 0 || container.clientHeight <= 0) {
        return;
      }
      const chart = echarts.init(container);
      chartRef.current = chart;
      previousViewRef.current = null;

      chart.on('datazoom', () => {
        // 缩放后选区的像素位置已变，重新框选比保留一个错位的选区更清楚。
        chart.dispatchAction({ type: 'brush', areas: [] });
        setSelection(null);
        const zooms = chart.getOption().dataZoom as SliderState[];
        const slider = zooms.find((zoom) => zoom.type === 'slider');
        if (!slider) {
          return;
        }
        const isFullRange = slider.start <= FULL_RANGE_TOLERANCE && slider.end >= 100 - FULL_RANGE_TOLERANCE;
        onRangeChangeRef.current(isFullRange ? null : { start: slider.startValue, end: slider.endValue });
      });

      chart.on('updateAxisPointer', (event) => {
        const axis = (event as AxisPointerEvent).axesInfo?.find((info) => info.axisDim === 'x');
        // 指针离开绘图区时保留最后位置，用户才能把鼠标移到按钮上。
        if (axis) {
          setHoverTime(axis.value);
        }
      });

      chart.on('brush', () => {
        isSelectingRef.current = true;
      });
      chart.on('brushEnd', (event) => {
        isSelectingRef.current = false;
        const range = (event as BrushEndEvent).areas[0]?.coordRange;
        // 选区保留在图上，由用户决定追问还是放大，而不是松开鼠标就缩放。
        setSelection(range && range[1] > range[0] ? { start: range[0], end: range[1] } : null);
      });
      setIsReady(true);
    };
    initializeChart();

    // 拖动分隔线和布局过渡都可能连续触发尺寸通知，一帧至多重绘一次。
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame === null) {
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          if (container.clientWidth > 0 && container.clientHeight > 0) {
            if (chartRef.current) {
              chartRef.current.resize();
            } else {
              initializeChart();
            }
          }
        });
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
      }
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!isReady || !chart) {
      return;
    }
    const isNewView = previousViewRef.current !== viewKey;
    chart.setOption(option, { notMerge: isNewView });
    previousViewRef.current = viewKey;
    enableDragSelection(chart);
    // 仅换测点、窗口或曲线内容时复位；换主题保留图例与已框选的范围。
    if (isNewView) {
      onRangeChangeRef.current(null);
      setSelection(null);
      setHoverTime(null);
    }
  }, [option, viewKey, isReady]);

  useEffect(() => {
    if (resetSignal === 0) return;
    chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }, [resetSignal, isReady]);

  useEffect(() => {
    if (!selection) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 焦点在别的弹层（如导航抽屉）里时，Esc 属于那个弹层，选区保持不变。
      const layer = event.target instanceof Element ? event.target.closest('[role="dialog"], [role="menu"]') : null;
      if (layer && !layer.contains(containerRef.current)) return;
      // 先取消选区，不同时关闭外层的依据面板。
      event.preventDefault();
      clearSelection();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [selection]);

  /** 按钮中心对准时间位置，并限制在绘图区宽度内。 */
  const askBarLeft = (time: number) => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;
    const pixel = chart.convertToPixel({ xAxisIndex: 0 }, time);
    if (typeof pixel !== 'number' || !Number.isFinite(pixel)) return null;
    const minimum = PLOT_LEFT + ASK_BAR_HALF_WIDTH;
    const maximum = container.clientWidth - PLOT_RIGHT - ASK_BAR_HALF_WIDTH;
    return Math.min(Math.max(pixel, minimum), Math.max(minimum, maximum));
  };

  const ask = (range: ChartRange) => {
    onAsk?.(range);
    clearSelection();
    setHoverTime(null);
  };

  let askBar: ReactNode = null;
  if (onAsk && selection) {
    const left = askBarLeft((selection.start + selection.end) / 2);
    if (left !== null) {
      askBar = (
        <div role="toolbar" aria-label="所选时间段" className="absolute flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-0.5 shadow-sm" style={{ left, top: ASK_BAR_TOP }}>
          <button type="button" disabled={askDisabled} onClick={() => ask(selection)} className={`${ASK_BUTTON_CLASS} bg-primary text-primary-foreground hover:bg-primary/90`}>问这段</button>
          <button type="button" aria-label="放大所选时间段" title="放大" className={`${ASK_BUTTON_CLASS} px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground`}
            onClick={() => {
              chartRef.current?.dispatchAction({ type: 'dataZoom', startValue: selection.start, endValue: selection.end });
            }}>
            <ZoomInIcon className="size-3.5" aria-hidden />
          </button>
          <button type="button" aria-label="取消选择" title="取消选择" onClick={clearSelection} className={`${ASK_BUTTON_CLASS} px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground`}>
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      );
    }
  } else if (onAsk && hoverTime !== null && !isSelectingRef.current) {
    const left = askBarLeft(hoverTime);
    const day = dayAround(hoverTime);
    if (left !== null) {
      askBar = (
        <button type="button" disabled={askDisabled} onClick={() => ask(day)}
          aria-label={`追问 ${formatDay(hoverTime)}`}
          className={`${ASK_BUTTON_CLASS} absolute -translate-x-1/2 border bg-popover text-foreground shadow-sm hover:bg-muted`}
          style={{ left, top: ASK_BAR_TOP }}>
          问{formatDay(hoverTime)}
        </button>
      );
    }
  }

  return (
    <div className="relative" onMouseLeave={() => setHoverTime(null)}>
      <div ref={containerRef} role="img" aria-label={label} className="h-96 w-full" />
      {askBar}
    </div>
  );
}
