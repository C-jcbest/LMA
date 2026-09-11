import React, { useState } from 'react';
import {
  Wrench,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Layers,
  MapPin,
  Activity,
  Calendar,
  Database,
  Code2,
} from 'lucide-react';
import { ToolCallInfo } from '../services/api';

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);

  // 解析工具详情数据
  let data: any = toolCall.detail;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = { raw: data };
    }
  }

  // 获取工具友好图标
  const getToolIcon = () => {
    if (toolCall.status === 'loading') {
      return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />;
    }
    if (toolCall.name?.includes('group')) {
      return <Layers className="w-3.5 h-3.5 text-neutral-600 shrink-0" />;
    }
    if (toolCall.name?.includes('station') && !toolCall.name?.includes('group')) {
      return <MapPin className="w-3.5 h-3.5 text-neutral-600 shrink-0" />;
    }
    if (toolCall.name?.includes('gnss') || toolCall.name?.includes('data')) {
      return <Activity className="w-3.5 h-3.5 text-neutral-600 shrink-0" />;
    }
    return <Database className="w-3.5 h-3.5 text-neutral-600 shrink-0" />;
  };

  // 生成顶部简短摘要
  const getSummaryBadge = () => {
    if (toolCall.status === 'loading') {
      return <span className="text-[11px] text-blue-600">正在查询...</span>;
    }
    if (data?.groups && Array.isArray(data.groups)) {
      return (
        <span className="text-[11px] text-neutral-500">
          获取到 {data.groups.length} 个监测分组
        </span>
      );
    }
    if (data?.stations && Array.isArray(data.stations)) {
      return (
        <span className="text-[11px] text-neutral-500">
          获取到 {data.stations.length} 个监测点
        </span>
      );
    }
    if (data?.total_points !== undefined) {
      return (
        <span className="text-[11px] text-neutral-500">
          获取到 {data.total_points} 条监测数据
        </span>
      );
    }
    if (toolCall.preview) {
      return <span className="text-[11px] text-neutral-500 truncate max-w-[240px]">{toolCall.preview}</span>;
    }
    return <span className="text-[11px] text-neutral-500 font-medium">已完成</span>;
  };

  // 渲染分组定制内容
  const renderGroupsView = (groups: any[]) => {
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-neutral-400 mb-1 flex items-center justify-between">
          <span>共 {groups.length} 个监测分组</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {groups.map((g, idx) => (
            <div
              key={idx}
              className="p-2 bg-neutral-50 border border-neutral-200/80 rounded-lg flex flex-col justify-between text-xs"
            >
              <div className="flex items-center justify-between gap-1 mb-1">
                <span className="font-semibold text-neutral-800 truncate">{g.group_name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-200/80 text-neutral-600 shrink-0">
                  {g.station_count ?? 0} 测点
                </span>
              </div>
              <p className="text-[11px] text-neutral-500 line-clamp-2">
                {g.description || '无分组备注信息'}
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // 渲染测点列表定制内容
  const renderStationsView = (stations: any[]) => {
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-neutral-400 mb-1">
          共查询到 {stations.length} 个测点详情
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {stations.slice(0, 10).map((s, idx) => {
            const isNormal = s.station_status === 10 || s.station_status === '正常';
            return (
              <div
                key={idx}
                className="p-2 bg-neutral-50 border border-neutral-200/80 rounded-lg flex items-center justify-between text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-neutral-800 truncate">{s.station_name}</div>
                  <div className="text-[10px] text-neutral-400 truncate">
                    {s.location || s.group_name || 'GNSS 监测站'}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isNormal ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <span className="text-[10px] text-neutral-500">
                    {isNormal ? '正常' : '告警/离线'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {stations.length > 10 && (
          <div className="text-center text-[10px] text-neutral-400 pt-1">
            已显示前 10 个测点，其余 {stations.length - 10} 个测点已载入智能体上下文中
          </div>
        )}
      </div>
    );
  };

  // 渲染 GNSS 日监测数据定制内容
  const renderGnssDataView = (gnssData: any) => {
    const points: any[] = gnssData.points || [];
    const previewPoints = points.slice(0, 4);

    return (
      <div className="space-y-2 text-xs">
        {/* 指标摘要 */}
        <div className="grid grid-cols-3 gap-2 bg-neutral-50 p-2 rounded-lg border border-neutral-200/60">
          <div>
            <div className="text-[10px] text-neutral-400">测点</div>
            <div className="font-semibold text-neutral-800 truncate">{gnssData.station_name || 'GNSS'}</div>
          </div>
          <div>
            <div className="text-[10px] text-neutral-400">有效数据</div>
            <div className="font-semibold text-emerald-600">{gnssData.total_points ?? points.length} 条</div>
          </div>
          <div>
            <div className="text-[10px] text-neutral-400">跨度</div>
            <div className="font-semibold text-neutral-700 truncate">
              {gnssData.begin_time ? gnssData.begin_time.slice(0, 10) : '近期'}
            </div>
          </div>
        </div>

        {/* 采样样本微缩预览 */}
        {previewPoints.length > 0 && (
          <div>
            <div className="text-[10px] text-neutral-400 mb-1">采样序列预览:</div>
            <div className="overflow-x-auto border border-neutral-200/70 rounded-md">
              <table className="w-full text-[11px] text-left">
                <thead className="bg-neutral-100/70 text-neutral-600">
                  <tr>
                    <th className="px-2 py-1 font-medium">时刻</th>
                    <th className="px-2 py-1 font-medium">N (m)</th>
                    <th className="px-2 py-1 font-medium">E (m)</th>
                    <th className="px-2 py-1 font-medium">U 垂直 (m)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 text-neutral-700">
                  {previewPoints.map((p, idx) => (
                    <tr key={idx} className="hover:bg-neutral-50/50">
                      <td className="px-2 py-0.5 whitespace-nowrap text-neutral-500">{p.time}</td>
                      <td className="px-2 py-0.5 font-mono">{Number(p.n).toFixed(3)}</td>
                      <td className="px-2 py-0.5 font-mono">{Number(p.e).toFixed(3)}</td>
                      <td className="px-2 py-0.5 font-mono">{Number(p.u).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染通用键值对内容
  const renderGenericView = (obj: any) => {
    if (!obj || typeof obj !== 'object') {
      return (
        <div className="text-xs text-neutral-600 bg-neutral-50 p-2 rounded-lg">
          {String(obj || '无返回数据')}
        </div>
      );
    }
    const entries = Object.entries(obj).filter(
      ([k]) => typeof obj[k] === 'string' || typeof obj[k] === 'number' || typeof obj[k] === 'boolean'
    );

    return (
      <div className="space-y-1.5 text-xs">
        <div className="grid grid-cols-2 gap-1.5">
          {entries.slice(0, 6).map(([key, val]) => (
            <div key={key} className="p-1.5 bg-neutral-50 border border-neutral-200/60 rounded">
              <div className="text-[10px] text-neutral-400 capitalize">{key}</div>
              <div className="font-medium text-neutral-800 truncate">{String(val)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // 根据数据形态选择合适的分支渲染
  const renderContentBody = () => {
    if (data?.groups && Array.isArray(data.groups)) {
      return renderGroupsView(data.groups);
    }
    if (data?.stations && Array.isArray(data.stations)) {
      return renderStationsView(data.stations);
    }
    if (data?.points || data?.total_points !== undefined) {
      return renderGnssDataView(data);
    }
    return renderGenericView(data);
  };

  return (
    <div className="my-1.5 text-xs border border-neutral-200/80 bg-white hover:bg-neutral-50/40 rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.02)] max-w-xl transition-all">
      {/* 简约折叠头部 */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2 text-neutral-700 min-w-0">
          {getToolIcon()}
          <span className="font-medium text-xs text-neutral-800 truncate">
            {toolCall.display_name || toolCall.name}
          </span>
          <span className="text-neutral-300">·</span>
          {getSummaryBadge()}
        </div>

        <div className="flex items-center gap-1 text-neutral-400 hover:text-neutral-600 shrink-0 ml-2">
          <span className="text-[11px]">{expanded ? '收起' : '详情'}</span>
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
      </div>

      {/* 展开内容区域：限制最大高度 max-h-56，内部平滑滚动，绝不超大撑破界面 */}
      {expanded && (
        <div className="px-3.5 py-2.5 bg-[#fafafa] border-t border-neutral-200/70 max-h-56 overflow-y-auto">
          {renderContentBody()}

          {/* 极轻量的查看原始 JSON 切换开关 */}
          <div className="mt-2 pt-2 border-t border-neutral-200/50 flex items-center justify-between text-[10px] text-neutral-400">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowRawJson(!showRawJson);
              }}
              className="hover:text-neutral-600 flex items-center gap-1 transition-colors"
            >
              <Code2 className="w-3 h-3" />
              <span>{showRawJson ? '收起原始 JSON' : '查看原始参数 (调试)'}</span>
            </button>
            <span className="text-neutral-400">只读快照</span>
          </div>

          {showRawJson && (
            <pre className="mt-1.5 p-2 bg-neutral-900 text-neutral-200 rounded-lg text-[10px] font-mono overflow-x-auto max-h-36">
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
