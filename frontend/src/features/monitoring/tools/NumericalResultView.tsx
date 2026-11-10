import type { NumericalArtifactData } from '@/types/envelope';

const axisNames: Record<string, string> = { n: '北向', e: '东向', u: '垂直' };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumSignificantDigits: 4 })
    : '未知';

function AxisMetrics({ feature }: { feature: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <p>有效点 {formatNumber(feature.count)} · 净变化 {formatNumber(feature.net_change_mm)} mm</p>
      <p>趋势速度 {formatNumber(feature.robust_slope_mm_day)} mm/day</p>
      {typeof feature.begin_time === 'string' && typeof feature.end_time === 'string' && (
        <p className="text-muted-foreground">实际覆盖：{feature.begin_time} 至 {feature.end_time}</p>
      )}
    </div>
  );
}

export function NumericalResultView({ data }: { data: NumericalArtifactData }) {
  const common = data.comparisons.common_period;
  const stationNames = data.comparisons.station_names;
  return (
    <div className="space-y-5 text-sm wrap-break-word">
      <p>{data.begin_time} 至 {data.end_time} · {data.sampling === 'daily' ? '每日15:00采样' : '小时采样'}</p>
      {Object.entries(data.features).map(([axis, feature]) => {
        const windows = data.comparisons[axis];
        return (
          <section key={axis} className="space-y-2">
            <h4 className="font-medium">{axisNames[axis] ?? axis}</h4>
            <AxisMetrics feature={feature} />
            <p>最大相邻变化 {formatNumber(feature.max_step_mm)} mm · 后续：{String(feature.jump_persistence)}</p>
            <p className="text-muted-foreground">{String(feature.method)}</p>
            {Array.isArray(feature.limitations) && feature.limitations.map((note, index) => <p key={index}>{String(note)}</p>)}
            {isRecord(windows) && isRecord(windows.first) && isRecord(windows.second) && (
              <div className="space-y-2 border-s ps-3">
                <h5 className="font-medium">两个窗口比较</h5>
                <p>前窗</p><AxisMetrics feature={windows.first} />
                <p>后窗</p><AxisMetrics feature={windows.second} />
                <p>速度差 {formatNumber(windows.velocity_difference_mm_day)} mm/day · 速度倍率 {formatNumber(windows.speed_ratio)}</p>
                <p className="text-muted-foreground">{String(windows.limitation)}</p>
              </div>
            )}
          </section>
        );
      })}
      {isRecord(common) && (
        <section className="space-y-3">
          <h4 className="font-medium">同组共同有效时段</h4>
          <p className="text-muted-foreground">仅比较各测点均有有效观测的同一时刻，缺测不插值。</p>
          {Object.entries(common).map(([axis, stations]) => isRecord(stations) && (
            <div key={axis} className="space-y-2">
              <h5 className="font-medium">{axisNames[axis] ?? axis}</h5>
              {Object.entries(stations).map(([stationId, feature]) => isRecord(feature) && (
                <div key={stationId} className="border-s ps-3">
                  <p>{isRecord(stationNames) ? String(stationNames[stationId] ?? '未命名测点') : '未命名测点'}</p>
                  <AxisMetrics feature={feature} />
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
