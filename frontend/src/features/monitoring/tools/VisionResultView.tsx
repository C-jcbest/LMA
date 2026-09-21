import React from 'react';
import type { ChartPointArtifact, VisionArtifactData } from '@/types/envelope';
import { toFiniteGnssNumber } from './gnssUtils';
import { EmptyResultView } from './EmptyResultView';

const CHART_TITLES: Record<string, string> = {
  raw_coordinates: '原始坐标时序（N/E/U）',
  cumulative_displacement: '累计位移（相对首点，mm）',
  resultant_displacement: '合成位移（水平/三维，mm）',
};

// 由 chart_points 生成单方向迷你 SVG 折线（归一化到 0~100 视口）
const buildPolyline = (
  points: ChartPointArtifact[],
  key: 'n' | 'e' | 'u'
): { lines: string[]; min: number; max: number } | null => {
  const values = points
    .map((p) => toFiniteGnssNumber(p[key]))
    .filter((value): value is number => value !== null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lines: string[] = [];
  let segment: string[] = [];
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * 100;
    const v = toFiniteGnssNumber(p[key]);
    if (v === null) {
      if (segment.length >= 2) lines.push(segment.join(' '));
      segment = [];
      return;
    }
    const y = 100 - ((v - min) / span) * 100;
    segment.push(`${x.toFixed(2)},${Math.max(2, Math.min(98, y)).toFixed(2)}`);
  });
  if (segment.length >= 2) lines.push(segment.join(' '));
  return lines.length > 0 ? { lines, min, max } : null;
};

export const VisionResultView: React.FC<{ data: VisionArtifactData }> = ({ data }) => {
  const visibleImages = data.images.filter((image) => CHART_TITLES[image.name]);
  const chartPoints = data.chart_points;
  if (chartPoints.length === 0 && visibleImages.length === 0) {
    return <EmptyResultView>该时间范围内暂无可供复核的 GNSS 数据</EmptyResultView>;
  }

  const obs = data.observations || {};
  const candidates = obs.candidates || [];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-neutral-400 px-0.5">
        <span>
          测点: <strong className="text-neutral-700">{data?.station_name || 'GNSS'}</strong>
          {data?.begin_time && data?.end_time && `（${data.begin_time.slice(0, 10)} ~ ${data.end_time.slice(0, 10)}）`}
        </span>
        <span>
          {data?.total_points ?? chartPoints.length} 条数据 ·
          {visibleImages.length > 0
            ? ` ${visibleImages.length} 张分析图`
            : ` 展示 ${chartPoints.length} 点`}
        </span>
      </div>
      {/* 后端渲染的分析图 PNG（原始时序 / 累计位移 / 合成位移） */}
      {visibleImages.length > 0 && (
        <div className="space-y-1.5">
          {visibleImages.map((img, i) => {
            const title = img.title || CHART_TITLES[img.name] || img.name;
            return (
              <figure
                key={img.name}
                className="border border-border/60 rounded-lg bg-background/60 overflow-hidden max-w-3xl"
              >
                <figcaption className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground border-b border-border/60 bg-muted/40">
                  图{i + 1} · {title}
                </figcaption>
                <img
                  src={`data:image/png;base64,${img.png_base64}`}
                  alt={title}
                  className="w-full h-auto block"
                  loading="lazy"
                />
              </figure>
            );
          })}
        </div>
      )}

      {/* 兜底：无 artifact 图片时用 chart_points 渲染 SVG 迷你时序图 */}
      {visibleImages.length === 0 && (
        <div className="border border-border/60 rounded-lg bg-background/60 p-3 space-y-2 max-w-3xl">
          {(['n', 'e', 'u'] as const).map((key) => {
            const label =
              key === 'n' ? 'N 北向 (m)' : key === 'e' ? 'E 东向 (m)' : 'U 垂直 (m)';
            const chart = buildPolyline(data.chart_points, key);
            return (
              <div key={key}>
                <div className="flex items-center justify-between text-[10px] text-neutral-400 mb-0.5">
                  <span>{label}</span>
                  {chart && (
                    <span className="font-mono">
                      {chart.min.toFixed(3)} ~ {chart.max.toFixed(3)}
                    </span>
                  )}
                </div>
                {chart ? (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="w-full h-14 bg-neutral-50/80 border border-neutral-100 rounded"
                  >
                    {chart.lines.map((line, index) => (
                      <polyline
                        key={index}
                        points={line}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth="1.2"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                ) : (
                  <div className="h-14 flex items-center justify-center text-[10px] text-neutral-300 bg-neutral-50/80 border border-neutral-100 rounded">
                    无有效数据
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 形态异常候选（轻量文本导引线，去外层黄色卡片与内层卡片） */}
      {candidates.length > 0 && (
        <div className="space-y-2 pt-1 max-w-3xl">
          <div className="text-[11px] font-medium text-foreground/80 flex items-center gap-1.5">
            <span>形态异常候选</span>
            <span className="font-mono text-xs text-amber-600 dark:text-amber-400 font-semibold">
              {candidates.length}
            </span>
          </div>
          <div className="space-y-2 ps-0.5">
            {candidates.map((c, i) => (
              <div
                key={i}
                className="border-s border-amber-300/60 ps-3 py-0.5 text-xs"
              >
                <div className="text-[11px] font-mono text-muted-foreground">
                  {c.metric} · {String(c.start_at).slice(0, 16)} — {String(c.end_at).slice(5, 16)}
                </div>
                <div className="mt-0.5 text-foreground/85 leading-relaxed">
                  {c.description || '（未描述）'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 形态观察摘要（轻量纯文本块，border-s border-border/60 ps-3） */}
      {(obs.fact_text ||
        (obs.trends && obs.trends.length > 0) ||
        (obs.turning_points && obs.turning_points.length > 0)) && (
        <div className="space-y-1.5 pt-1 max-w-3xl border-s border-border/60 ps-3">
          <div className="text-[11px] font-medium text-muted-foreground">观察结果</div>
          {obs.fact_text && (
            <div className="text-xs text-foreground/85 leading-relaxed">{obs.fact_text}</div>
          )}
          {((obs.trends?.length ?? 0) > 0 ||
            (obs.turning_points?.length ?? 0) > 0) && (
            <ul className="space-y-0.5 text-[11px] text-foreground/80">
              {obs.trends?.map((t: string, i: number) => (
                <li key={`t${i}`} className="flex gap-1.5">
                  <span className="text-muted-foreground/60">•</span>
                  <span>趋势：{t}</span>
                </li>
              ))}
              {obs.turning_points?.map((t: string, i: number) => (
                <li key={`p${i}`} className="flex gap-1.5">
                  <span className="text-muted-foreground/60">•</span>
                  <span>拐点：{t}</span>
                </li>
              ))}
            </ul>
          )}
          {obs.image_quality && (
            <div className="text-[10px] text-muted-foreground/70">图像质量：{obs.image_quality}</div>
          )}
        </div>
      )}
    </div>
  );
};

export const VisionResult = VisionResultView;
