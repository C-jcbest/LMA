import React from 'react';
import type { GnssArtifactData } from '@/types/envelope';
import { formatGnssValue } from './gnssUtils';
import { EmptyResultView } from './EmptyResultView';

export const GnssResultView: React.FC<{ data: GnssArtifactData }> = ({ data }) => {
  if (!data?.points || !Array.isArray(data.points)) return null;
  const allPoints = data.points;
  if (allPoints.length === 0) {
    return <EmptyResultView>该时间范围内暂无 GNSS 数据</EmptyResultView>;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-neutral-400 px-0.5">
        <span>
          测点: <strong className="text-neutral-700">{data.station_name || 'GNSS'}</strong>
        </span>
        <span>
          已加载 {allPoints.length} 条采样记录（共 {data.total_points ?? allPoints.length} 条
          {data.downsampled ? '，超限已等间隔降采样' : ''}，支持上下滚动）
        </span>
      </div>
      <div className="border border-border/60 rounded-lg bg-background/60 h-56 max-h-56 overflow-y-auto overscroll-contain">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted/40 text-muted-foreground font-medium border-b border-border/60">
            <tr>
              <th className="py-2 px-3 whitespace-nowrap">#</th>
              <th className="py-2 px-3 whitespace-nowrap">采样时刻</th>
              <th className="py-2 px-3 whitespace-nowrap">北向坐标 N (m)</th>
              <th className="py-2 px-3 whitespace-nowrap">东向坐标 E (m)</th>
              <th className="py-2 px-3 whitespace-nowrap">垂直坐标 U (m)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40 text-neutral-800 font-mono text-[11px]">
            {allPoints.map((p, i) => (
              <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                <td className="py-1 px-3 text-neutral-400">{i + 1}</td>
                <td className="py-1 px-3 text-neutral-600 whitespace-nowrap">{p.time}</td>
                <td className="py-1 px-3">{formatGnssValue(p.n)}</td>
                <td className="py-1 px-3">{formatGnssValue(p.e)}</td>
                <td className="py-1 px-3">{formatGnssValue(p.u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const GnssResult = GnssResultView;
