import { useEffect, useState } from 'react';
import { useTheme } from '@/app/providers/ThemeProvider';
import type { ChartColors } from './timeline';

const readChartColors = (): ChartColors => {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    text: token('--foreground'),
    mutedText: token('--muted-foreground'),
    grid: token('--border'),
    surface: token('--popover'),
    border: token('--border'),
    primary: token('--foreground'),
    north: token('--chart-north'),
    east: token('--chart-east'),
    up: token('--chart-up'),
    rain: token('--chart-rain'),
    peer: token('--chart-peer'),
    gap: token('--chart-gap'),
  };
};

/** 图表画在 canvas 上读不到 CSS 变量，主题切换后重新取一次颜色。 */
export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState(readChartColors);
  useEffect(() => {
    setColors(readChartColors());
  }, [resolvedTheme]);
  return colors;
}
