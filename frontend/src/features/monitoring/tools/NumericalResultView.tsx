import type { FC, ReactNode } from 'react';
import type { GnssArtifactData } from '@/types/envelope';
import { formatSigned, MILLIMETER_DIGITS, RATE_DIGITS } from '../format';

const AXIS_NAMES: Record<string, string> = { n: '北向', e: '东向', u: '垂直', h: '水平合成', d: '三维合成' };

type Feature = Record<string, unknown>;

const isRecord = (value: unknown): value is Feature =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatNumber = (value: unknown, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : '—';

const formatSignedValue = (value: unknown, digits = MILLIMETER_DIGITS) =>
  typeof value === 'number' && Number.isFinite(value) ? formatSigned(value, digits) : '—';

const SimpleTable: FC<{ head: ReactNode[]; rows: ReactNode[][]; label: string }> = ({ head, rows, label }) => (
  <div className="overflow-x-auto rounded-lg border">
    <table aria-label={label} className="w-full min-w-[32rem] border-collapse text-left text-sm tabular-nums">
      <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
        <tr>{head.map((cell, index) => <th key={index} className="px-3 py-2 font-normal whitespace-nowrap">{cell}</th>)}</tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className={cellIndex === 0 ? 'px-3 py-1.5 whitespace-nowrap text-muted-foreground' : 'px-3 py-1.5'}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const slopeText = (feature: Feature) =>
  `${formatSignedValue(feature.robust_slope_mm_day, RATE_DIGITS)}${feature.trend_supported ? '' : '（描述）'}`;

const featureRow = (label: string, feature: Feature): ReactNode[] => [
  label,
  formatSignedValue(feature.cum_end_mm),
  formatSignedValue(feature.net_change_mm),
  slopeText(feature),
  formatNumber(feature.max_step_mm),
  `${formatNumber(feature.count, 0)}`,
];

const FEATURE_HEAD = ['方向', '累计 (mm)', '本窗口 (mm)', '速率 (mm/天)', '最大单步 (mm)', '有效点'];

const eventsOf = (features: Record<string, Feature>) =>
  Object.entries(features).flatMap(([axis, feature]) => (
    Array.isArray(feature.events)
      ? feature.events.filter(isRecord).map((event) => ({ axis, event }))
      : []
  ));

/** 位移结果中服务端计算的数值特征：先看各方向汇总，再看台阶与分段对比。 */
export function NumericalResultView({ data }: { data: GnssArtifactData }) {
  const features = (data.features ?? {}) as Record<string, Feature>;
  const comparisons = data.comparisons ?? {};
  const common = comparisons.common_period;
  const stationNames = isRecord(comparisons.station_names) ? comparisons.station_names : {};
  const events = eventsOf(features);
  const windowComparisons = Object.entries(features)
    .map(([axis]) => [axis, comparisons[axis]] as const)
    .filter((entry): entry is readonly [string, Feature] => isRecord(entry[1]) && isRecord(entry[1].first) && isRecord(entry[1].second));
  const limitations = [...new Set(Object.values(features).flatMap((feature) => (
    Array.isArray(feature.limitations) ? feature.limitations.map(String) : []
  )))];

  return (
    <div className="space-y-5 text-sm wrap-break-word">
      <SimpleTable
        label="各方向数值特征"
        head={FEATURE_HEAD}
        rows={Object.entries(features).map(([axis, feature]) => featureRow(AXIS_NAMES[axis] ?? axis, feature))}
      />

      {events.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-medium">台阶候选</h4>
          <SimpleTable
            label="台阶候选"
            head={['方向', '发生时刻', '单步 (mm)', '后续', '已观察保持']}
            rows={events.map(({ axis, event }) => [
              AXIS_NAMES[axis] ?? axis,
              String(event.time ?? '—').slice(0, 16),
              formatSignedValue(event.step_mm),
              `${String(event.status ?? '—')}${Array.isArray(event.later_unknown_intervals) && event.later_unknown_intervals.length > 0 ? '，之后有缺测' : ''}`,
              `${formatNumber(event.held_hours, 0)} 小时`,
            ])}
          />
        </section>
      )}

      {windowComparisons.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-medium">前后两段比较</h4>
          <SimpleTable
            label="前后两段比较"
            head={['方向', '前段速率', '后段速率', '速度差 (mm/天)', '倍率']}
            rows={windowComparisons.map(([axis, windows]) => [
              AXIS_NAMES[axis] ?? axis,
              slopeText(windows.first as Feature),
              slopeText(windows.second as Feature),
              formatSignedValue(windows.velocity_difference_mm_day, RATE_DIGITS),
              formatNumber(windows.speed_ratio, 2),
            ])}
          />
          {windowComparisons.map(([axis, windows]) => typeof windows.limitation === 'string' && (
            <p key={axis} className="text-xs text-muted-foreground">{windows.limitation}</p>
          ))}
        </section>
      )}

      {isRecord(common) && (
        <section className="space-y-2">
          <h4 className="font-medium">同组共同时段</h4>
          <p className="text-xs text-muted-foreground">只比较各测点都有有效观测的同一时刻，缺测不插值。</p>
          {Object.entries(common).map(([axis, stations]) => isRecord(stations) && (
            <SimpleTable
              key={axis}
              label={`${AXIS_NAMES[axis] ?? axis}共同时段`}
              head={[AXIS_NAMES[axis] ?? axis, ...FEATURE_HEAD.slice(1)]}
              rows={Object.entries(stations).filter(([, feature]) => isRecord(feature)).map(([stationId, feature]) => (
                featureRow(String(stationNames[stationId] ?? '未命名测点'), feature as Feature)
              ))}
            />
          ))}
        </section>
      )}

      {limitations.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {limitations.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
