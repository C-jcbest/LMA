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
import {
  getToolRegistryItem,
  decodeToolArtifact,
  parseOutputRecord,
  isRecord,
} from './tools/registry';

export { toFiniteGnssNumber, formatGnssValue, parseOutputRecord };

type ToolCallBlock = Extract<ContentBlock.Standard, { type: 'tool_call' }>;
type LiveToolCall = AssembledToolCall;

interface InlineToolCallProps {
  toolCall: ToolCallBlock;
  liveToolCall?: LiveToolCall;
  toolMessage?: ToolMessage;
}

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

export const InlineToolCall: React.FC<InlineToolCallProps> = ({
  toolCall,
  liveToolCall,
  toolMessage,
}) => {
  const registryItem = getToolRegistryItem(toolCall.name);
  const [expanded, setExpanded] = useState(registryItem.defaultExpanded ?? false);

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

  // 通过统一协议信封解码器解码
  const envelope = decodeToolArtifact(
    toolCall.name,
    toolMessage?.artifact,
    liveToolCall?.output
  );

  const artifact = isRecord(toolMessage?.artifact) ? toolMessage.artifact : undefined;
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

  const rawData = envelope.data;
  const data: any = rawData && isRecord(rawData) ? { ...rawData } : rawData;
  if (data && isRecord(data)) {
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

  // 生成简约的中文动作文案（优先从 registry 获取）
  const getActionText = () => {
    const suffix = isError ? '（未完成）' : '';
    return `${registryItem.label}${suffix}`;
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

    const Renderer = registryItem.render;
    return (
      <Renderer
        envelope={envelope}
        data={data}
        artifactImages={artifactImages}
        siteEnvironment={siteEnvironment}
      />
    );
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
          {renderContent()}
        </div>
      )}
    </div>
  );
};
