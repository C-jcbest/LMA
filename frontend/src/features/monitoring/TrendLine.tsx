import type { FC } from 'react';
import { cn } from '@/lib/utils';

const VIEW_WIDTH = 200;
const VIEW_HEIGHT = 40;
const PADDING = 3;
// 幅度很小的序列不放大到撑满高度，避免把噪声画成剧烈波动。
const MIN_SPAN_MM = 3;

interface TrendLineProps {
  values: readonly (number | null)[];
  /** 需要关注的趋势用主题色并填充，其余保持灰色。 */
  emphasized?: boolean;
  className?: string;
}

/** 列表里的趋势缩略图：宽度跟随容器，缺测处断开。 */
export const TrendLine: FC<TrendLineProps> = ({ values, emphasized = false, className }) => {
  const validValues = values.filter((value): value is number => value !== null);
  if (validValues.length < 2) {
    return null;
  }

  const min = Math.min(...validValues);
  const span = Math.max(Math.max(...validValues) - min, MIN_SPAN_MM);
  const toX = (index: number) => PADDING + (index / (values.length - 1)) * (VIEW_WIDTH - PADDING * 2);
  const toY = (value: number) => PADDING + (1 - (value - min) / span) * (VIEW_HEIGHT - PADDING * 2);

  let startsSegment = true;
  const commands: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      startsSegment = true;
      return;
    }
    commands.push(`${startsSegment ? 'M' : 'L'}${toX(index).toFixed(1)},${toY(value).toFixed(1)}`);
    startsSegment = false;
  });
  const line = commands.join(' ');
  const isContinuous = validValues.length === values.length;

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn('block h-10 w-full', emphasized ? 'text-chart-north' : 'text-status-unknown', className)}
    >
      {emphasized && isContinuous && (
        <path
          d={`${line} L${toX(values.length - 1)},${VIEW_HEIGHT} L${toX(0)},${VIEW_HEIGHT} Z`}
          fill="currentColor"
          opacity="0.1"
        />
      )}
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};
