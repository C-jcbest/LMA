import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Button } from '@/components/ui/button';
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

export default function RainfallChart({ days, height = 140, onAsk, askDisabled }: { days: readonly DailyRain[]; height?: number; onAsk?: (day: DailyRain) => void; askDisabled?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const colors = useChartColors();
  const [isReady, setIsReady] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = days.find((day) => day.date === selectedDate);

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
      transitionDuration: typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 0.12,
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
    const container = containerRef.current!;
    const resize = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      if (chartRef.current) {
        chartRef.current.resize();
      } else {
        chartRef.current = echarts.init(container);
        setIsReady(true);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: true });
    const selectDay = ({ offsetX, offsetY }: { offsetX: number; offsetY: number }) => {
      if (!chart.containPixel({ gridIndex: 0 }, [offsetX, offsetY])) return;
      const index = chart.convertFromPixel({ xAxisIndex: 0 }, offsetX);
      setSelectedDate(days[Number(index)]?.date ?? null);
    };
    chart.getZr().on('click', selectDay);
    return () => { chart.getZr()?.off('click', selectDay); };
  }, [isReady, option, days]);

  return (
    <div className="relative">
      <div ref={containerRef} role="img" aria-label="逐日降雨柱状图" className="w-full" style={{ height }} />
      {selected && onAsk && <Button type="button" size="xs" className="absolute end-2 top-0 rounded-full" disabled={askDisabled} onClick={() => {
        onAsk(selected);
        setSelectedDate(null);
      }}>问 {selected.date.slice(5)} 降雨</Button>}
    </div>
  );
}
