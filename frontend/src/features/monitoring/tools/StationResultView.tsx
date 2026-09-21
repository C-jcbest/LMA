import React from 'react';
import type { StationListArtifactData } from '@/types/envelope';
import { EmptyResultView } from './EmptyResultView';

export const StationResultView: React.FC<{ data: StationListArtifactData }> = ({ data }) => {
  // 1. 监测分组表格（展示全部数据，无截断）
  if (data?.groups && Array.isArray(data.groups)) {
    if (data.groups.length === 0) {
      return <EmptyResultView>暂无监测点分组</EmptyResultView>;
    }
    return (
      <div className="space-y-1">
        <div className="text-[11px] text-neutral-400 px-0.5">
          共查询到 {data.groups.length} 个监测分组
        </div>
        <div className="border border-border/60 rounded-lg bg-background/60 max-h-64 overflow-auto overscroll-contain">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-muted/40 text-muted-foreground font-medium border-b border-border/60">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">分组名称</th>
                <th className="py-2 px-3 whitespace-nowrap">监测点数</th>
                <th className="py-2 px-3">分组说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 text-neutral-800">
              {data.groups.map((g, i) => (
                <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                  <td className="py-2 px-3 font-medium text-neutral-900 whitespace-nowrap">{g.group_name}</td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <span className="inline-block px-1.5 py-0.5 bg-neutral-100 rounded text-neutral-700 text-[11px]">
                      {g.station_count ?? 0} 个测点
                    </span>
                  </td>
                  <td className="py-2 px-3 text-neutral-500">{g.description || '（无描述）'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 2. 监测点列表表格（展示全部数据，支持纵向滚动）
  if (data?.stations && Array.isArray(data.stations)) {
    if (data.stations.length === 0) {
      return <EmptyResultView>暂无符合条件的监测点</EmptyResultView>;
    }
    const statusStyles: Record<string, { dot: string; text: string }> = {
      正常: { dot: 'bg-emerald-500', text: '正常' },
      离线: { dot: 'bg-neutral-400', text: '离线' },
      告警: { dot: 'bg-amber-500', text: '告警' },
      故障: { dot: 'bg-red-500', text: '故障' },
    };

    return (
      <div className="space-y-1">
        <div className="text-[11px] text-neutral-400 px-0.5">
          共查询到 {data.stations.length} 个监测点详情
        </div>
        <div className="border border-border/60 rounded-lg bg-background/60 max-h-64 overflow-auto overscroll-contain">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-muted/40 text-muted-foreground font-medium border-b border-border/60">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">序号</th>
                <th className="py-2 px-3 whitespace-nowrap">监测点名称</th>
                <th className="py-2 px-3 whitespace-nowrap">当前状态</th>
                <th className="py-2 px-3 whitespace-nowrap">所属分组 / 位置</th>
                <th className="py-2 px-3 whitespace-nowrap">测点类型</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 text-neutral-800">
              {data.stations.map((s, i) => {
                const status =
                  (typeof s.station_status === 'string'
                    ? statusStyles[s.station_status]
                    : undefined) || {
                  dot: 'bg-neutral-300',
                  text: '未知',
                };
                return (
                  <tr key={i} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="py-2 px-3 text-neutral-400 font-mono text-[11px]">{i + 1}</td>
                    <td className="py-2 px-3 font-mono font-medium text-neutral-900 whitespace-nowrap">
                      {s.station_name}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-neutral-100/90">
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                        <span className="text-neutral-700">{status.text}</span>
                      </span>
                    </td>
                    <td className="py-2 px-3 text-neutral-600">
                      {s.location || s.group_name || '-'}
                    </td>
                    <td className="py-2 px-3 text-neutral-400 text-[11px] whitespace-nowrap">
                      {typeof s.station_type === 'string' && s.station_type.trim()
                        ? s.station_type
                        : '未知'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return null;
};

export const StationResult = StationResultView;
