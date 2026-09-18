import React, { useState } from 'react';
import {
  ChevronRight,
  Loader2,
  Check,
  AlertCircle,
} from 'lucide-react';
import type { ContentBlock, ToolMessage } from '@langchain/core/messages';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import type {
  ChartPoint,
  SiteEnvironmentArtifact,
  SiteStation,
  ToolCallImage,
} from './toolArtifacts';
import { toFiniteGnssNumber, formatGnssValue } from './tools/gnssUtils';
import { StationResultView } from './tools/StationResultView';
import { GnssResultView } from './tools/GnssResultView';
import { WeatherResultView } from './tools/WeatherResultView';
import { VisionResultView } from './tools/VisionResultView';
import { SiteEnvironmentResultView } from './tools/SiteEnvironmentResultView';
import { EmptyOrGenericResultView } from './tools/EmptyOrGenericResultView';

export { toFiniteGnssNumber, formatGnssValue };

type ToolCallBlock = Extract<ContentBlock.Standard, { type: 'tool_call' }>;
type LiveToolCall = AssembledToolCall;

interface InlineToolCallProps {
  toolCall: ToolCallBlock;
  liveToolCall?: LiveToolCall;
  toolMessage?: ToolMessage;
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSiteStation = (value: unknown): value is SiteStation =>
  isRecord(value) &&
  typeof value.station_uuid === 'string' &&
  typeof value.station_name === 'string' &&
  value.coordinate_system === 'WGS84';

const isSiteEnvironmentArtifact = (value: unknown): value is SiteEnvironmentArtifact =>
  isRecord(value) &&
  value.coordinate_system === 'WGS84' &&
  isSiteStation(value.center_station) &&
  Array.isArray(value.group_stations) &&
  value.group_stations.every(isSiteStation) &&
  (value.sources === undefined || Array.isArray(value.sources)) &&
  (value.limitations === undefined || Array.isArray(value.limitations));

export const parseOutputRecord = (output: unknown): Record<string, any> | undefined => {
  if (isRecord(output)) return output;
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const InlineToolCall: React.FC<InlineToolCallProps> = ({
  toolCall,
  liveToolCall,
  toolMessage,
}) => {
  const [expanded, setExpanded] = useState(false);

  // 错误仅判断官方明确错误
  const isError =
    toolMessage?.status === 'error' ||
    liveToolCall?.status === 'error';

  // 成功判断“工具结果是否已经返回”（优先 ToolMessage，实时阶段 liveToolCall.output 已产生）
  const hasToolMessageResult = toolMessage !== undefined && toolMessage.status !== 'error';
  const isLiveRunning = (liveToolCall?.status as string | undefined) === 'running';
  const hasLiveOutput =
    !isLiveRunning &&
    liveToolCall !== undefined &&
    liveToolCall.status !== 'error' &&
    liveToolCall.output !== undefined;
  const hasResult = !isError && (hasToolMessageResult || hasLiveOutput);

  // 尚未收到任何结果且无错误时一律为 pending（正在查询…）
  const isPending = !isError && !hasResult;
  const pendingText = '正在查询，请稍候…';

  const artifact = isRecord(toolMessage?.artifact) ? toolMessage.artifact : undefined;
  const artifactData = isRecord(artifact?.data) ? artifact.data : undefined;
  const artifactImages = Array.isArray(artifact?.images)
    ? artifact.images.filter(
        (image): image is ToolCallImage =>
          isRecord(image) && typeof image.name === 'string' && typeof image.png_base64 === 'string'
      )
    : [];
  const chartPoints = Array.isArray(artifact?.chart_points)
    ? artifact.chart_points.filter(
        (point): point is ChartPoint => isRecord(point) && typeof point.t === 'string'
      )
    : [];

  const liveOutputRecord = parseOutputRecord(liveToolCall?.output);

  const siteEnvironment = isSiteEnvironmentArtifact(artifact?.site_environment)
    ? artifact.site_environment
    : isSiteEnvironmentArtifact(liveOutputRecord?.site_environment)
    ? liveOutputRecord.site_environment
    : undefined;

  // 两阶段数据源：优先消费持久化的 ToolMessage.artifact.data，未到达前使用 liveToolCall.output 即时展示
  const rawData = artifactData ?? liveOutputRecord;
  const data: any = rawData ? { ...rawData } : null;
  if (data) {
    if (chartPoints.length) data.chart_points = chartPoints;
    else if (!Array.isArray(data.chart_points)) delete data.chart_points;
  }

  // 图标
  const renderIcon = () => {
    if (isPending) {
      return <Loader2 className="w-3.5 h-3.5 text-neutral-400 animate-spin shrink-0" data-status="pending" />;
    }
    if (isError) {
      return <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" data-status="error" />;
    }
    return <Check className="w-3.5 h-3.5 text-neutral-400 shrink-0" data-status="finished" />;
  };

  // 生成简约的中文动作文案
  const getActionText = () => {
    const suffix = isError ? '（未完成）' : '';
    if (toolCall.name === 'list_station_groups') {
      return `查询监测点分组${suffix}`;
    }
    if (toolCall.name === 'list_stations') {
      return `查询监测点列表${suffix}`;
    }
    if (toolCall.name === 'get_daily_gnss_data') {
      return `获取北斗GNSS日监测数据${suffix}`;
    }
    if (toolCall.name === 'query_weather') {
      return `查询天气数据${suffix}`;
    }
    if (toolCall.name === 'analyze_gnss_chart') {
      return `视觉复核${suffix}`;
    }
    if (toolCall.name === 'inspect_site_environment') {
      return `调查站点地形与地质环境${suffix}`;
    }
    return `执行工具查询${suffix}`;
  };

  const renderContent = () => {
    if (isPending) {
      return (
        <div className="flex items-center gap-2 p-3 bg-neutral-50 border border-neutral-200/80 rounded-lg text-xs text-neutral-500">
          <Loader2 className="w-3.5 h-3.5 text-neutral-400 animate-spin shrink-0" />
          {pendingText}
        </div>
      );
    }
    if (isError && !data?.chart_points) return null;

    if (data?.chart_points && Array.isArray(data.chart_points)) {
      return <VisionResultView data={data} artifactImages={artifactImages} />;
    }

    if (data?.current && data?.rain_summary) {
      return <WeatherResultView data={data} />;
    }

    if ((data?.groups && Array.isArray(data.groups)) || (data?.stations && Array.isArray(data.stations))) {
      return <StationResultView data={data} />;
    }

    if (data?.points && Array.isArray(data.points)) {
      return <GnssResultView data={data} />;
    }

    return <EmptyOrGenericResultView />;
  };

  return (
    <div className="my-2 text-xs">
      <div
        onClick={() => setExpanded(!expanded)}
        data-status={isPending ? 'pending' : isError ? 'error' : 'finished'}
        className="inline-flex items-center gap-1.5 py-1 px-2 -ml-1 rounded-md text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/80 cursor-pointer transition-colors select-none"
      >
        {renderIcon()}
        <span className="font-normal">{getActionText()}</span>
        <ChevronRight
          className={`w-3.5 h-3.5 text-neutral-400 transition-transform duration-200 ${
            expanded ? 'rotate-90 text-neutral-600' : ''
          }`}
        />
      </div>

      {isError && (
        <div role="alert" className="mt-1 max-w-3xl rounded-lg border border-amber-200/80 bg-amber-50/60 p-2.5 text-xs text-amber-900">
          {typeof data?.message === 'string' && data.message
            ? data.message
            : typeof liveToolCall?.error === 'string' && liveToolCall.error
            ? liveToolCall.error
            : '未获得结果'}
        </div>
      )}

      {expanded && (
        <div
          className={`mt-1.5 max-w-3xl ${
            siteEnvironment
              ? ''
              : 'max-h-[28rem] overflow-y-auto overscroll-contain animate-in fade-in duration-150'
          }`}
        >
          {siteEnvironment ? (
            <SiteEnvironmentResultView environment={siteEnvironment} />
          ) : (
            renderContent()
          )}
        </div>
      )}
    </div>
  );
};
