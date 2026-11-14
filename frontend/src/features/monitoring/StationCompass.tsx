import type { FC } from 'react';

const SIZE = 120;
const CENTER = SIZE / 2;
const RADIUS = 46;
const SECTOR_HALF_ANGLE = 22.5;
const MIN_ARROW_LENGTH = 0.35;

export interface CompassReading {
  /** 水平位移方位（从正北顺时针，度）。 */
  azimuth: number;
  magnitudeMillimeters: number;
  /** 场地下坡方向（坡向）；没有查过场地时为 null。 */
  downslopeAzimuth: number | null;
  /** true：相对固定参考的累计位移；false：本窗口内的变化。 */
  cumulative: boolean;
}

const pointAt = (azimuth: number, radius: number) => {
  const radians = (azimuth * Math.PI) / 180;
  return { x: CENTER + radius * Math.sin(radians), y: CENTER - radius * Math.cos(radians) };
};

/** 两个方位之间的最小夹角（0–180°）。 */
export const angleBetween = (first: number, second: number) => {
  const difference = Math.abs(((first - second) % 360 + 360) % 360);
  return difference > 180 ? 360 - difference : difference;
};

const sectorPath = (azimuth: number) => {
  const start = pointAt(azimuth - SECTOR_HALF_ANGLE, RADIUS);
  const end = pointAt(azimuth + SECTOR_HALF_ANGLE, RADIUS);
  return `M${CENTER},${CENTER} L${start.x},${start.y} A${RADIUS},${RADIUS} 0 0 1 ${end.x},${end.y} Z`;
};

/**
 * 单测点调查时，用户从地图真正需要的是位移往哪个方向、与下坡方向差多少。
 * 北向上的罗盘：箭头为水平位移方位，扇形为下坡方向；纯 SVG，不依赖底图和网络。
 */
export const StationCompass: FC<{ reading: CompassReading }> = ({ reading }) => {
  // 箭头长度只表示有没有明显位移，不按比例尺；很小的位移也保留可见长度。
  const arrowLength = RADIUS * Math.max(MIN_ARROW_LENGTH, Math.min(1, reading.magnitudeMillimeters / 20));
  const tip = pointAt(reading.azimuth, arrowLength);
  const headLeft = pointAt(reading.azimuth - 150, 8);
  const headRight = pointAt(reading.azimuth + 150, 8);
  const head = `M${tip.x},${tip.y} L${tip.x + headLeft.x - CENTER},${tip.y + headLeft.y - CENTER} L${tip.x + headRight.x - CENTER},${tip.y + headRight.y - CENTER} Z`;
  const difference = reading.downslopeAzimuth === null ? null : angleBetween(reading.azimuth, reading.downslopeAzimuth);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img"
        aria-label={`水平位移方位约 ${Math.round(reading.azimuth)}°${reading.downslopeAzimuth === null ? '' : `，下坡方向约 ${Math.round(reading.downslopeAzimuth)}°`}`}
        className="shrink-0 text-muted-foreground">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.35} />
        {[0, 90, 180, 270].map((azimuth) => {
          const outer = pointAt(azimuth, RADIUS);
          const inner = pointAt(azimuth, RADIUS - 5);
          return <line key={azimuth} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="currentColor" strokeOpacity={0.5} />;
        })}
        <text x={CENTER} y={9} textAnchor="middle" fontSize={10} fill="currentColor">北</text>
        {reading.downslopeAzimuth !== null && (
          <path d={sectorPath(reading.downslopeAzimuth)} fill="var(--status-normal)" fillOpacity={0.18} stroke="var(--status-normal)" strokeOpacity={0.6} strokeDasharray="3 2" />
        )}
        <line x1={CENTER} y1={CENTER} x2={tip.x} y2={tip.y} stroke="var(--foreground)" strokeWidth={2} strokeLinecap="round" />
        <path d={head} fill="var(--foreground)" />
        <circle cx={CENTER} cy={CENTER} r={2.5} fill="var(--foreground)" />
      </svg>
      <dl className="grid gap-y-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{reading.cumulative ? '累计水平位移' : '本窗口水平变化'}</dt>
          <dd className="tabular-nums">{reading.magnitudeMillimeters.toFixed(1)} mm · 方位 {Math.round(reading.azimuth)}°</dd>
        </div>
        {reading.downslopeAzimuth !== null ? (
          <>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">下坡方向</dt>
              <dd className="tabular-nums">{Math.round(reading.downslopeAzimuth)}°（约 90 m 地形平均坡面）</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">两者夹角</dt>
              <dd className="tabular-nums">{Math.round(difference!)}°</dd>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">未查询场地坡向，不比较是否顺坡</p>
        )}
      </dl>
    </div>
  );
};
