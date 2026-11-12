import { useEffect, useRef, useState } from 'react';
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

export default function TimelineChart({ viewKey, option, label, resetSignal, onRangeChange }: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const previousViewRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

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
        const zooms = chart.getOption().dataZoom as SliderState[];
        const slider = zooms.find((zoom) => zoom.type === 'slider');
        if (!slider) {
          return;
        }
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
    enableDragToZoom(chart);
    // 仅换测点、窗口或曲线内容时复位；换主题保留图例与已框选的范围。
    if (isNewView) {
      onRangeChangeRef.current(null);
    }
  }, [option, viewKey, isReady]);

  useEffect(() => {
    if (resetSignal === 0) return;
    chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }, [resetSignal, isReady]);

  return <div ref={containerRef} role="img" aria-label={label} className="h-96 w-full" />;
}
