import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useChartColors } from '../chartColors';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface DailyRain {
  date: string;
  value: number | null;
  isForecast: boolean;
}

interface TooltipItem {
  dataIndex: number;
}

/** 逐日降雨柱状图：带 mm 坐标便于比对各天雨量，悬停或点按看当天数值，预报日用浅色。 */
export default function RainfallChart({ days, height = 140 }: { days: readonly DailyRain[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const colors = useChartColors();

  const option = useMemo(() => ({
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    grid: { left: 40, right: 8, top: 22, bottom: 24 },
    xAxis: {
      type: 'category',
      data: days.map((day) => day.date.slice(5)),
      axisLine: { lineStyle: { color: colors.border } },
      axisTick: { show: false },
      axisLabel: { color: colors.mutedText, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 2,
      name: 'mm',
      nameTextStyle: { color: colors.mutedText },
      axisLabel: { color: colors.mutedText, fontSize: 11 },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      textStyle: { color: colors.text, fontSize: 13 },
      formatter: (params: TooltipItem[]) => {
        const day = days[params[0]!.dataIndex]!;
        const value = day.value === null ? '缺测' : `${day.value} mm`;
        return `${day.date}<br/>日降雨 ${value}${day.isForecast ? '（预报）' : ''}`;
      },
    },
    series: [{
      type: 'bar',
      barCategoryGap: '20%',
      data: days.map((day) => ({
        value: day.value,
        itemStyle: { color: colors.rain, opacity: day.isForecast ? 0.45 : 1, borderRadius: [2, 2, 0, 0] },
      })),
    }],
  }), [days, colors]);

  useEffect(() => {
    const chart = echarts.init(containerRef.current!);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current!);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={containerRef} role="img" aria-label="逐日降雨柱状图" className="w-full" style={{ height }} />;
}
