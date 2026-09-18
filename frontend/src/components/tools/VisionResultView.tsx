import React from 'react';
import { Eye } from 'lucide-react';
import type { ToolResultProps } from './types';
import { toFiniteGnssNumber } from './gnssUtils';

const CHART_TITLES: Record<string, string> = {
  raw_coordinates: '原始坐标时序（N/E/U）',
  cumulative_displacement: '累计位移（相对首点，mm）',
  resultant_displacement: '合成位移（水平/三维，mm）',
};

// 由 chart_points 生成单方向迷你 SVG 折线（归一化到 0~100 视口）
const buildPolyline = (
  points: any[],
  key: string
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

export const VisionResultView: React.FC<ToolResultProps> = ({
  data,
  artifactImages = [],
}) => {
  if (!data?.chart_points || !Array.isArray(data.chart_points)) return null;

  const obs = data.observations || {};
  const candidates: any[] = obs.candidates || [];
  const visibleImages = artifactImages.filter((image) => CHART_TITLES[image.name]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-neutral-400 px-0.5">
        <span>
          测点: <strong className="text-neutral-700">{data.station_name}</strong>
          （{data.begin_time?.slice(0, 10)} ~ {data.end_time?.slice(0, 10)}）
        </span>
        <span>
          {data.total_points ?? data.chart_points.length} 条数据 ·
          {visibleImages.length > 0
            ? ` ${visibleImages.length} 张分析图`
            : ` 展示 ${data.chart_points.length} 点`}
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
                className="border border-neutral-200/90 rounded-lg bg-white shadow-sm overflow-hidden max-w-3xl"
              >
                <figcaption className="px-3 py-1.5 text-[11px] font-medium text-neutral-600 border-b border-neutral-100 bg-[#f9fafb]">
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
        <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm space-y-2 max-w-3xl">
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

      {/* 异常候选（高亮） */}
      {candidates.length > 0 && (
        <div className="border border-amber-200/80 rounded-lg bg-amber-50/60 p-2.5 max-w-3xl">
          <div className="text-[11px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" />形态异常候选（{candidates.length}）
          </div>
          <div className="space-y-1.5">
            {candidates.map((c: any, i: number) => (
              <div
                key={i}
                className="text-xs text-neutral-800 bg-white/80 border border-amber-100 rounded-md px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                  <span className="px-1.5 py-0.5 bg-neutral-100 rounded font-mono">{c.metric}</span>
                  <span className="font-mono">
                    {String(c.start_at).slice(0, 16)} ~ {String(c.end_at).slice(5, 16)}
                  </span>
                </div>
                <div className="mt-1">{c.description || '（未描述）'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 形态观察摘要 */}
      {(obs.fact_text ||
        (obs.trends && obs.trends.length > 0) ||
        (obs.turning_points && obs.turning_points.length > 0)) && (
        <div className="border border-neutral-200/90 rounded-lg bg-white p-3 shadow-sm max-w-3xl">
          {obs.fact_text && (
            <div className="text-xs text-neutral-800 leading-relaxed">{obs.fact_text}</div>
          )}
          {(obs.trends?.length > 0 || obs.turning_points?.length > 0) && (
            <ul className="mt-1.5 space-y-1">
              {obs.trends?.map((t: string, i: number) => (
                <li key={`t${i}`} className="text-[11px] text-neutral-600 flex gap-1.5">
                  <span className="text-neutral-300">•</span>
                  <span>趋势：{t}</span>
                </li>
              ))}
              {obs.turning_points?.map((t: string, i: number) => (
                <li key={`p${i}`} className="text-[11px] text-neutral-600 flex gap-1.5">
                  <span className="text-neutral-300">•</span>
                  <span>拐点：{t}</span>
                </li>
              ))}
            </ul>
          )}
          {obs.image_quality && (
            <div className="mt-1.5 text-[10px] text-neutral-400">图像质量：{obs.image_quality}</div>
          )}
        </div>
      )}
    </div>
  );
};
