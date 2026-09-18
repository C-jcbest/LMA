import React, { useState, useMemo } from 'react';
import { defineToolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { Check, ChevronDown, ChevronRight, Loader2, AlertCircle } from 'lucide-react';
import type { ToolArtifactEnvelope } from '../types/envelope';
import { decodeToolEnvelope, TOOL_KIND_MAP } from './toolResultAdapter';
import { GnssResultView } from '../features/monitoring/GnssResultView';
import { WeatherResultView } from '../features/monitoring/WeatherResultView';
import { StationResultView } from '../features/monitoring/StationResultView';
import { VisionResultView } from '../features/monitoring/VisionResultView';
import { SiteEnvironmentView } from '../features/monitoring/SiteEnvironmentView';
import { EmptyOrGenericResultView } from '../features/monitoring/EmptyOrGenericResultView';

export interface ToolCardContainerProps {
  label: string;
  args?: Record<string, unknown>;
  result?: unknown;
  artifact?: unknown;
  status?: ToolCallMessagePartProps['status'];
  isError?: boolean;
  defaultExpanded?: boolean;
  toolName?: string;
  children: (props: { envelope: ToolArtifactEnvelope; isError: boolean }) => React.ReactNode;
}

/**
 * 统一的工具卡片容器外壳：负责折叠/展开、运行中/成功/失败状态呈现，以及参数摘要显示
 */
export const ToolCardContainer: React.FC<ToolCardContainerProps> = ({
  label,
  args,
  result,
  artifact,
  status,
  isError = false,
  defaultExpanded = false,
  toolName = '',
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // 直接使用工具部分绑定的 artifact 与 result 解码，不依赖任何消息列表扫描
  const envelope = useMemo(() => {
    return decodeToolEnvelope(toolName, artifact, result);
  }, [toolName, artifact, result]);

  const isRunning = status?.type === 'running';
  const hasError = isError || envelope.status === 'error' || status?.type === 'incomplete';

  // 参数提要文本
  const argsSummary = useMemo(() => {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args).filter(([k]) => !k.startsWith('_'));
    if (!entries.length) return '';
    return entries
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ');
  }, [args]);

  return (
    <div className="my-2 rounded-xl border border-neutral-200/90 bg-neutral-50/60 overflow-hidden text-xs shadow-2xs">
      {/* 头部状态与折叠触发按钮 */}
      <button
        type="button"
        onClick={() => !isRunning && setIsExpanded((prev) => !prev)}
        className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors select-none ${
          isRunning ? 'cursor-default' : 'cursor-pointer hover:bg-neutral-100/70'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isRunning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600 shrink-0" />
          ) : hasError ? (
            <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-emerald-600" />
            </div>
          )}

          <span className="font-medium text-neutral-800 truncate">{label}</span>

          {argsSummary && !isRunning && (
            <span className="text-[11px] text-neutral-400 truncate max-w-xs font-mono">
              ({argsSummary})
            </span>
          )}

          {isRunning && <span className="text-[11px] text-neutral-400">正在查询…</span>}
        </div>

        {!isRunning && (
          <div className="flex items-center gap-1 text-neutral-400 shrink-0 ml-2">
            <span className="text-[11px]">{isExpanded ? '收起' : '展开结果'}</span>
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </div>
        )}
      </button>

      {/* 展开的详情内容 */}
      {isExpanded && !isRunning && (
        <div className="border-t border-neutral-200/80 bg-white p-3">
          {hasError ? (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800">
              <div className="font-semibold text-xs mb-1">工具执行失败</div>
              <div className="text-[11px] leading-relaxed">
                {envelope.error?.message ||
                  (typeof result === 'string' ? result : '查询遇到未知异常')}
              </div>
            </div>
          ) : (
            children({ envelope, isError: hasError })
          )}
        </div>
      )}
    </div>
  );
};

export const GnssToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  return (
    <ToolCardContainer
      label="获取北斗GNSS日监测数据"
      defaultExpanded={true}
      toolName="get_daily_gnss_data"
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
    >
      {({ envelope }) => <GnssResultView data={envelope.data} />}
    </ToolCardContainer>
  );
};

export const WeatherToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  return (
    <ToolCardContainer
      label="查询天气数据"
      defaultExpanded={true}
      toolName="query_weather"
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
    >
      {({ envelope }) => <WeatherResultView data={envelope.data} />}
    </ToolCardContainer>
  );
};

export const StationToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  return (
    <ToolCardContainer
      label="查询监测点列表"
      defaultExpanded={true}
      toolName="list_stations"
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
    >
      {({ envelope }) => <StationResultView data={envelope.data} />}
    </ToolCardContainer>
  );
};

export const VisionToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  return (
    <ToolCardContainer
      label="视觉复核"
      defaultExpanded={true}
      toolName="visual_review"
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
    >
      {({ envelope }) => (
        <VisionResultView data={envelope.data} artifactImages={envelope.images} />
      )}
    </ToolCardContainer>
  );
};

export const SiteEnvironmentToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  return (
    <ToolCardContainer
      label="调查站点地形与地质环境"
      defaultExpanded={true}
      toolName="site_environment"
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
    >
      {({ envelope }) => {
        const env =
          envelope.site_environment || envelope.data?.site_environment || envelope.data;
        if (!env || !env.center_station) return <EmptyOrGenericResultView />;
        return <SiteEnvironmentView environment={env} />;
      }}
    </ToolCardContainer>
  );
};

/**
 * 官方推荐的 assistant-ui Toolkit 定义：
 * 后端 / LangGraph 执行 Tool，前端负责渲染
 */
export const lmaToolkit = defineToolkit({
  get_daily_gnss_data: {
    type: 'backend',
    render: GnssToolUI,
  },
  query_weather: {
    type: 'backend',
    render: WeatherToolUI,
  },
  list_stations: {
    type: 'backend',
    render: StationToolUI,
  },
  list_station_groups: {
    type: 'backend',
    render: StationToolUI,
  },
  visual_review: {
    type: 'backend',
    render: VisionToolUI,
  },
  analyze_gnss_chart: {
    type: 'backend',
    render: VisionToolUI,
  },
  site_environment: {
    type: 'backend',
    render: SiteEnvironmentToolUI,
  },
  inspect_site_environment: {
    type: 'backend',
    render: SiteEnvironmentToolUI,
  },
});
