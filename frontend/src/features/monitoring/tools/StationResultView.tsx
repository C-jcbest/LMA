import React from 'react';
import { cn } from '@/lib/utils';
import type { StationListArtifactData } from '@/types/envelope';
import { EmptyResultView } from './EmptyResultView';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const STATUS_DOT_STYLES: Record<string, string> = {
  正常: 'bg-status-normal',
  离线: 'bg-status-unknown',
  告警: 'bg-status-attention',
  故障: 'bg-status-critical',
};

export const StationStatus: React.FC<{ status: unknown }> = ({ status }) => {
  const isKnown = typeof status === 'string' && Object.hasOwn(STATUS_DOT_STYLES, status);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', isKnown ? STATUS_DOT_STYLES[status] : 'bg-status-unknown')} aria-hidden />
      {isKnown ? status : '未知'}
    </span>
  );
};


/** 测点查询同时返回分组与测点：有测点时列测点，只有分组时列分组。 */
export const StationResultView: React.FC<{ data: StationListArtifactData }> = ({ data }) => {
  if (data.stations.length === 0) {
    if (data.groups.length === 0) {
      return <EmptyResultView>暂无符合条件的监测点</EmptyResultView>;
    }
    return (
      <Table containerClassName="rounded-lg border">
          <TableHeader>
            <TableRow>
              <TableHead>分组</TableHead>
              <TableHead>测点</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.groups.map((group, index) => (
              <TableRow key={index}>
                <TableCell className="whitespace-nowrap font-medium">{group.group_name}</TableCell>
                <TableCell className="whitespace-nowrap">{group.station_count}</TableCell>
                <TableCell className="text-muted-foreground">{group.description || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
      </Table>
    );
  }

  return (
    <Table containerClassName="rounded-lg border">
        <TableHeader>
          <TableRow>
            <TableHead>测点</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>分组 / 位置</TableHead>
            <TableHead>类型</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.stations.map((station, index) => (
            <TableRow key={station.station_uuid || index}>
              <TableCell className="whitespace-nowrap font-medium">{station.station_name}</TableCell>
              <TableCell><StationStatus status={station.station_status} /></TableCell>
              <TableCell className="text-muted-foreground">{station.location || station.group_name || '—'}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {typeof station.station_type === 'string' && station.station_type.trim() ? station.station_type : '未知'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
    </Table>
  );
};
