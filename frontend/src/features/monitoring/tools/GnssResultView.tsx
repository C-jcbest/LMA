import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { GnssArtifactData } from '@/types/envelope';
import { formatGnssValue } from './gnssUtils';
import { EmptyResultView } from './EmptyResultView';

const INITIAL_ROW_COUNT = 100;

export const GnssResultView: React.FC<{ data: GnssArtifactData }> = ({ data }) => {
  const [isShowingAll, setIsShowingAll] = useState(false);
  const allPoints = data.points;
  if (allPoints.length === 0) {
    return <EmptyResultView>该时间范围内暂无 GNSS 数据</EmptyResultView>;
  }
  const visiblePoints = isShowingAll ? allPoints : allPoints.slice(0, INITIAL_ROW_COUNT);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground wrap-break-word">
        {data.begin_time} 至 {data.end_time} · {data.timezone} · {allPoints.length} / {data.total_points} 条
        {data.downsampled ? ' · 已降采样' : ''}
      </p>
      <div className="min-w-0 rounded-lg border">
        <table className="w-full table-fixed border-collapse text-left text-xs sm:text-sm">
          <thead className="border-b bg-muted/50 text-muted-foreground">
            <tr>
              <th className="w-[34%] px-2 py-2 font-medium">采样时刻</th>
              <th className="px-2 py-2 font-medium">N (m)</th>
              <th className="px-2 py-2 font-medium">E (m)</th>
              <th className="px-2 py-2 font-medium">U (m)</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {visiblePoints.map((point, index) => (
              <tr key={index}>
                <td className="px-2 py-1.5 text-muted-foreground [overflow-wrap:anywhere]">{point.time}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.n)}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.e)}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visiblePoints.length < allPoints.length && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setIsShowingAll(true)}>
          显示全部 {allPoints.length} 条
        </Button>
      )}
    </div>
  );
};
