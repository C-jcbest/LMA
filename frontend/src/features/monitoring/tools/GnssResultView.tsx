import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { GnssArtifactData } from '@/types/envelope';
import { formatGnssValue } from './gnssUtils';
import { EmptyResultView } from './EmptyResultView';

const PAGE_SIZE = 100;

export const GnssResultView: React.FC<{ data: GnssArtifactData }> = ({ data }) => {
  const [pageIndex, setPageIndex] = useState(0);
  const allPoints = data.points;
  if (allPoints.length === 0) {
    return <EmptyResultView>该时间范围内暂无 GNSS 数据</EmptyResultView>;
  }
  const pageCount = Math.ceil(allPoints.length / PAGE_SIZE);
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const firstRow = currentPage * PAGE_SIZE;
  const visiblePoints = allPoints.slice(firstRow, firstRow + PAGE_SIZE);

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
              <tr key={firstRow + index}>
                <td className="px-2 py-1.5 text-muted-foreground [overflow-wrap:anywhere]">{point.time}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.n)}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.e)}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{formatGnssValue(point.u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <nav aria-label="GNSS 数据分页" className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPageIndex(currentPage - 1)}>
            上一页
          </Button>
          <span role="status" className="text-sm text-muted-foreground tabular-nums">
            第 {currentPage + 1} / {pageCount} 页 · {firstRow + 1}–{firstRow + visiblePoints.length} 条
          </span>
          <Button type="button" variant="outline" size="sm" disabled={currentPage === pageCount - 1} onClick={() => setPageIndex(currentPage + 1)}>
            下一页
          </Button>
        </nav>
      )}
    </div>
  );
};
