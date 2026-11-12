import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent, CanvasRenderer]);

interface EvidenceChartProps {
  option: echarts.EChartsCoreOption;
  label: string;
  height: number;
}

/** 正文里的静态曲线：只看不缩放，缩放与框选追问留给依据面板。 */
export default function EvidenceChart({ option, label, height }: EvidenceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const chart = echarts.init(container);
    chartRef.current = chart;
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        chart.resize();
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
      }
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={containerRef} role="img" aria-label={label} className="w-full" style={{ height }} />;
}
