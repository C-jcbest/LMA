import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  AxisPointerComponent,
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
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
  option: echarts.EChartsCoreOption;
  label: string;
  resetSignal: number;
  onRangeChange: (range: ChartRange | null) => void;
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

/** 有指针时拖选放大；触屏上拖动留给页面滚动，用底部滑块缩放。 */
const enableDragToZoom = (chart: echarts.ECharts) => {
  if (!window.matchMedia('(hover: hover)').matches) return;
  chart.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'lineX', brushMode: 'single' },
  });
};

export default function TimelineChart({ option, label, resetSignal, onRangeChange }: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  useEffect(() => {
    const chart = echarts.init(containerRef.current!);
    chartRef.current = chart;

    chart.on('datazoom', () => {
      const zooms = chart.getOption().dataZoom as SliderState[];
      const slider = zooms.find((zoom) => zoom.type === 'slider');
      if (!slider) return;
      const isFullRange = slider.start <= FULL_RANGE_TOLERANCE && slider.end >= 100 - FULL_RANGE_TOLERANCE;
      onRangeChangeRef.current(isFullRange ? null : { start: slider.startValue, end: slider.endValue });
    });

    chart.on('brushEnd', (event) => {
      const range = (event as BrushEndEvent).areas[0]?.coordRange;
      chart.dispatchAction({ type: 'brush', areas: [] });
      if (range) {
        chart.dispatchAction({ type: 'dataZoom', startValue: range[0], endValue: range[1] });
      }
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current!);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current!;
    chart.setOption(option, { notMerge: true });
    enableDragToZoom(chart);
    onRangeChangeRef.current(null);
  }, [option]);

  useEffect(() => {
    if (resetSignal === 0) return;
    chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }, [resetSignal]);

  return <div ref={containerRef} role="img" aria-label={label} className="h-96 w-full" />;
}
