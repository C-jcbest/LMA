import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { GnssArtifactData } from '@/types/envelope';
import { formatGnssValue } from './gnssUtils';
import { EmptyResultView } from './EmptyResultView';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
      <Table containerClassName="min-w-0 rounded-lg border" className="table-fixed text-xs sm:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead className="w-1/3 whitespace-normal">采样时刻</TableHead>
            <TableHead>N (m)</TableHead>
            <TableHead>E (m)</TableHead>
            <TableHead>U (m)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visiblePoints.map((point, index) => (
            <TableRow key={firstRow + index}>
              <TableCell className="text-muted-foreground wrap-anywhere">{point.time}</TableCell>
              <TableCell className="wrap-anywhere">{formatGnssValue(point.n)}</TableCell>
              <TableCell className="wrap-anywhere">{formatGnssValue(point.e)}</TableCell>
              <TableCell className="wrap-anywhere">{formatGnssValue(point.u)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
