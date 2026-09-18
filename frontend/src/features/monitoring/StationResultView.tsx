import React from 'react';

export interface StationResultViewProps {
  data: any;
}

export const StationResultView: React.FC<StationResultViewProps> = React.memo(({ data }) => {
  // 1. 监测分组表格
  if (data?.groups && Array.isArray(data.groups)) {
    return (
      <div className="space-y-1">
        <div className="text-[11px] text-neutral-400 px-0.5">
          共查询到 {data.groups.length} 个监测分组
        </div>
        <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">分组名称</th>
                <th className="py-2 px-3 whitespace-nowrap">监测点数</th>
                <th className="py-2 px-3">分组说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800">
              {data.groups.map((g: any, i: number) => (
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

  // 2. 监测点列表表格
  if (data?.stations && Array.isArray(data.stations)) {
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
        <div className="border border-neutral-200/90 rounded-lg bg-white max-h-64 overflow-auto overscroll-contain shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-[#f9fafb] text-neutral-600 font-semibold border-b border-neutral-200/90 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
              <tr>
                <th className="py-2 px-3 whitespace-nowrap">序号</th>
                <th className="py-2 px-3 whitespace-nowrap">监测点名称</th>
                <th className="py-2 px-3 whitespace-nowrap">当前状态</th>
                <th className="py-2 px-3 whitespace-nowrap">所属分组 / 位置</th>
                <th className="py-2 px-3 whitespace-nowrap">测点类型</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800">
              {data.stations.map((s: any, i: number) => {
                const status = statusStyles[s.station_status] || {
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
});
StationResultView.displayName = 'StationResultView';
