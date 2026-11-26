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
  MarkLineComponent,
  MarkPointComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { XIcon, ZoomInIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AskKind } from './ask-targets';
import { chartClock, chartDay, rainfallDays } from './chart-time';

echarts.use([
  CustomChart,
  LineChart,
  AxisPointerComponent,
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface ChartRange {
  start: number;
  end: number;
  kind?: AskKind;
}

export interface ChartSelection extends ChartRange {
  kind: AskKind;
}

export interface ChartViewState {
  zoom?: { start: number; end: number; kind?: AskKind };
  legend?: Record<string, boolean>;
  selection?: ChartSelection | null;
}

interface TimelineChartProps {
  viewKey: string;
  option: echarts.EChartsCoreOption;
  label: string;
  resetSignal: number;
  onRangeChange: (range: ChartRange | null) => void;
  onAsk?: (range: ChartSelection) => void;
  hasRainfall?: boolean;
  askDisabled?: boolean;
  initialState?: ChartViewState;
  onStateChange?: (state: ChartViewState) => void;
  height?: number;
  allowZoom?: boolean;
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

const FULL_RANGE_TOLERANCE = 0.01;
const ASK_BAR_TOP = 28;
const ASK_BAR_HALF_WIDTH = 68;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 12;

interface AxisPointerEvent {
  axesInfo?: Array<{ axisDim?: string; axisIndex?: number; value?: number }>;
}

const enableDragSelection = (chart: echarts.ECharts) => {
  if (!window.matchMedia('(hover: hover)').matches) return;
  chart.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'lineX', brushMode: 'single' },
  });
};

const formatDay = (time: number) => {
  const [, month, day] = chartClock(time).slice(0, 10).split('-');
  return Number(month) + '月' + Number(day) + '日';
};

export default function TimelineChart({
  viewKey, option, label, resetSignal, onRangeChange, onAsk, askDisabled = false, initialState, onStateChange,
  height = 384, allowZoom = true, hasRainfall = false,
}: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const previousViewRef = useRef<string | null>(null);
  const previousHasRainfallRef = useRef<boolean | null>(null);
  const snappedAxisTimeRef = useRef<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [hover, setHover] = useState<{ time: number; kind: AskKind } | null>(null);
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const dragKind = useRef<AskKind>('displacement');
  const zoomKind = useRef<AskKind>('displacement');
  const hasRainfallRef = useRef(hasRainfall);
  hasRainfallRef.current = hasRainfall;
  const isSelectingRef = useRef(false);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const saveViewState = (selected = selectionRef.current) => {
    const chart = chartRef.current;
    if (!chart || !onStateChangeRef.current) {
      return;
    }
    const current = chart.getOption();
    const slider = (current.dataZoom as SliderState[] | undefined)?.find((item) => item.type === 'slider');
    const legend = (current.legend as { selected?: Record<string, boolean> }[])?.[0]?.selected;
    onStateChangeRef.current({
      zoom: slider ? { start: slider.start, end: slider.end, kind: zoomKind.current } : undefined,
      legend, selection: selected,
    });
  };

  const clearSelection = () => {
    chartRef.current?.dispatchAction({ type: 'brush', areas: [] });
    setSelection(null);
    saveViewState(null);
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
        chart.dispatchAction({ type: 'brush', areas: [] });
        setSelection(null);
        const zooms = chart.getOption().dataZoom as SliderState[];
        const slider = zooms.find((zoom) => zoom.type === 'slider');
        if (!slider) {
          return;
        }
        const isFullRange = slider.start <= FULL_RANGE_TOLERANCE && slider.end >= 100 - FULL_RANGE_TOLERANCE;
        const kind = zoomKind.current;
        const bounds = kind === 'rainfall' ? rainfallDays(slider.startValue, slider.endValue) : { start: slider.startValue, end: slider.endValue };
        const range = { ...bounds, kind };
        onRangeChangeRef.current(isFullRange ? null : range);
        if (isFullRange) zoomKind.current = 'displacement';
        saveViewState(null);
      });
      chart.on('legendselectchanged', () => saveViewState());
      chart.on('updateAxisPointer', (event) => {
        const axesInfo = (event as AxisPointerEvent).axesInfo;
        const xAxisInfo = axesInfo?.find((info) => info.axisDim === 'x' && typeof info.value === 'number' && Number.isFinite(info.value));
        snappedAxisTimeRef.current = xAxisInfo?.value ?? null;
      });

      const gridAt = (point: [number, number]) => {
        if (hasRainfallRef.current && chart.containPixel({ gridIndex: 1 }, point)) {
          const legend = chart.getOption().legend as { selected?: Record<string, boolean> }[] | undefined;
          return legend?.[0]?.selected?.['日降雨'] === false ? null : 1;
        }
        return chart.containPixel({ gridIndex: 0 }, point) ? 0 : null;
      };
      const updateHover = ({ offsetX, offsetY }: { offsetX: number; offsetY: number }) => {
        const grid = gridAt([offsetX, offsetY]);
        if (grid === null) {
          snappedAxisTimeRef.current = null;
          setHover(null);
          return;
        }
        const snapped = snappedAxisTimeRef.current;
        const converted = chart.convertFromPixel({ xAxisIndex: grid }, offsetX);
        const time = typeof snapped === 'number' && Number.isFinite(snapped) ? snapped : converted;
        if (typeof time === 'number' && Number.isFinite(time)) {
          setHover({ time, kind: grid === 1 ? 'rainfall' : 'displacement' });
        }
      };
      chart.getZr().on('mousemove', updateHover);
      chart.getZr().on('click', updateHover);
      chart.getZr().on('mousedown', ({ offsetX, offsetY }) => {
        dragKind.current = gridAt([offsetX, offsetY]) === 1 ? 'rainfall' : 'displacement';
      });

      chart.on('brush', () => {
        isSelectingRef.current = true;
      });
      chart.on('brushEnd', (event) => {
        isSelectingRef.current = false;
        const range = (event as BrushEndEvent).areas[0]?.coordRange;
        const selected = range && range[1] > range[0] ? { start: range[0], end: range[1], kind: dragKind.current } : null;
        setSelection(selected);
        saveViewState(selected);
      });
      setIsReady(true);
    };
    initializeChart();

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
    const rainfallLayoutChanged = previousHasRainfallRef.current !== null && previousHasRainfallRef.current !== hasRainfall;
    chart.setOption(option, { notMerge: isNewView || rainfallLayoutChanged });
    previousViewRef.current = viewKey;
    previousHasRainfallRef.current = hasRainfall;
    enableDragSelection(chart);
    if (isNewView) {
      zoomKind.current = initialState?.zoom?.kind ?? 'displacement';
      snappedAxisTimeRef.current = null;
      onRangeChangeRef.current(null);
      setSelection(null);
      setHover(null);
      if (initialState?.legend) {
        chart.setOption({ legend: { selected: initialState.legend } });
      }
      if (initialState?.zoom) {
        chart.dispatchAction({ type: 'dataZoom', ...initialState.zoom });
      }
      if (initialState?.selection) {
        const { start, end, kind } = initialState.selection;
        chart.dispatchAction({ type: 'brush', areas: [{ brushType: 'lineX', xAxisIndex: kind === 'rainfall' && hasRainfall ? 1 : 0, coordRange: [start, end] }] });
        setSelection(initialState.selection);
        saveViewState(initialState.selection);
      }
    }
  }, [option, viewKey, hasRainfall, isReady]);

  useEffect(() => {
    chartRef.current?.resize();
  }, [height]);

  useEffect(() => {
    if (resetSignal === 0) return;
    chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }, [resetSignal, isReady]);

  useEffect(() => {
    if (!selection) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const layer = event.target instanceof Element ? event.target.closest('[role="dialog"], [role="menu"]') : null;
      if (layer && !layer.contains(containerRef.current)) return;
      event.preventDefault();
      clearSelection();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [selection]);

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

  const ask = (range: ChartSelection) => {
    onAsk?.(range.kind === 'rainfall' ? { ...rainfallDays(range.start, range.end), kind: range.kind } : range);
    clearSelection();
    setHover(null);
  };

  let askBar: ReactNode = null;
  if (onAsk && selection) {
    const left = askBarLeft((selection.start + selection.end) / 2);
    if (left !== null) {
      askBar = (
        <div role="toolbar" aria-label="所选时间段" className="absolute flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-0.5 shadow-sm" style={{ left, top: ASK_BAR_TOP }}>
          <Button type="button" size="xs" disabled={askDisabled} onClick={() => ask(selection)} className="rounded-full px-2.5">{selection.kind === 'rainfall' ? '问这段降雨' : '问这段'}</Button>
          {allowZoom && (
            <Button type="button" variant="ghost" size="icon-xs" aria-label="放大所选时间段" title="放大" className="rounded-full text-muted-foreground"
              onClick={() => {
                zoomKind.current = selection.kind;
                chartRef.current?.dispatchAction({ type: 'dataZoom', startValue: selection.start, endValue: selection.end });
              }}>
              <ZoomInIcon aria-hidden />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon-xs" aria-label="取消选择" title="取消选择" onClick={clearSelection} className="rounded-full text-muted-foreground">
            <XIcon aria-hidden />
          </Button>
        </div>
      );
    }
  } else if (onAsk && hover !== null && !isSelectingRef.current) {
    const day = chartDay(hover.time);
    askBar = (
      <div className="animate-in fade-in duration-150 absolute end-3 top-0 flex items-center gap-0.5 rounded-full border bg-popover/95 p-0.5 shadow-sm backdrop-blur-sm">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={askDisabled}
          onClick={() => ask({ ...day, kind: hover.kind })}
          aria-label={`追问 ${formatDay(hover.time)}`}
          className="rounded-full px-2.5 text-foreground hover:bg-muted"
        >
          问{formatDay(hover.time)}{hover.kind === 'rainfall' ? '降雨' : ''}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="关闭日期追问"
          onClick={() => setHover(null)}
          className="rounded-full text-muted-foreground sm:hidden"
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div ref={containerRef} role="img" aria-label={label} className="w-full" style={{ height }} />
      {askBar}
    </div>
  );
}
