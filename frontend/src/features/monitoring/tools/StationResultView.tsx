import React from 'react';
import type { StationListArtifactData } from '@/types/envelope';
import { EmptyResultView } from './EmptyResultView';

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
      <span className={`size-1.5 rounded-full ${isKnown ? STATUS_DOT_STYLES[status] : 'bg-status-unknown'}`} aria-hidden />
      {isKnown ? status : '未知'}
    </span>
  );
};

const HEADER_CELL_CLASS = 'whitespace-nowrap px-3 py-2 font-medium';
const CELL_CLASS = 'px-3 py-2';

/** 测点查询同时返回分组与测点：有测点时列测点，只有分组时列分组。 */
export const StationResultView: React.FC<{ data: StationListArtifactData }> = ({ data }) => {
  if (data.stations.length === 0) {
    if (data.groups.length === 0) {
      return <EmptyResultView>暂无符合条件的监测点</EmptyResultView>;
    }
    return (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="border-b bg-muted/50 text-muted-foreground">
            <tr>
              <th className={HEADER_CELL_CLASS}>分组</th>
              <th className={HEADER_CELL_CLASS}>测点</th>
              <th className={HEADER_CELL_CLASS}>说明</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.groups.map((group, index) => (
              <tr key={index}>
                <td className={`${CELL_CLASS} whitespace-nowrap font-medium`}>{group.group_name}</td>
                <td className={`${CELL_CLASS} whitespace-nowrap tabular-nums`}>{group.station_count}</td>
                <td className={`${CELL_CLASS} text-muted-foreground`}>{group.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b bg-muted/50 text-muted-foreground">
          <tr>
            <th className={HEADER_CELL_CLASS}>测点</th>
            <th className={HEADER_CELL_CLASS}>状态</th>
            <th className={HEADER_CELL_CLASS}>分组 / 位置</th>
            <th className={HEADER_CELL_CLASS}>类型</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.stations.map((station, index) => (
            <tr key={station.station_uuid || index}>
              <td className={`${CELL_CLASS} whitespace-nowrap font-medium`}>{station.station_name}</td>
              <td className={CELL_CLASS}><StationStatus status={station.station_status} /></td>
              <td className={`${CELL_CLASS} text-muted-foreground`}>{station.location || station.group_name || '—'}</td>
              <td className={`${CELL_CLASS} whitespace-nowrap text-muted-foreground`}>
                {typeof station.station_type === 'string' && station.station_type.trim() ? station.station_type : '未知'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
