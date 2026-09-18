import React, { useState, useMemo } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { useLangChainStream } from '@assistant-ui/react-langchain';
import { Check, ChevronDown, ChevronRight, Loader2, AlertCircle } from 'lucide-react';
import { decodeToolEnvelope, TOOL_KIND_MAP } from '../../agent/toolResultAdapter';
import { getMonitoringRenderer } from '../../agent/toolkit';

export const ToolFallback: React.FC<ToolCallMessagePartProps> = ({
  toolName,
  args,
  result,
  status,
}) => {
  const stream = useLangChainStream();
  const meta = TOOL_KIND_MAP[toolName] || {
    label: toolName || '工具查询',
    kind: 'generic',
    defaultExpanded: false,
  };

  const [isExpanded, setIsExpanded] = useState(Boolean(meta.defaultExpanded));

  // 获取对应的 ToolMessage（如果有）中的 artifact
  const toolMessage = useMemo(() => {
    return (stream?.messages || []).find(
      (m: any) => m._getType?.() === 'tool' && (m.name === toolName || m.tool_call_id)
    );
  }, [stream?.messages, toolName]);

  const envelope = useMemo(() => {
    return decodeToolEnvelope(toolName, (toolMessage as any)?.artifact, result);
  }, [toolName, (toolMessage as any)?.artifact, result]);

  const isRunning = status?.type === 'running';
  const isError = envelope.status === 'error' || status?.type === 'incomplete';

  const Renderer = getMonitoringRenderer(envelope.kind);

  // 参数提要文本
  const argsSummary = useMemo(() => {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args).filter(([k]) => !k.startsWith('_'));
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
  }, [args]);

  return (
    <div className="my-2 rounded-xl border border-neutral-200/90 bg-neutral-50/60 overflow-hidden text-xs shadow-2xs">
      {/* 头部摘要栏 */}
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
          ) : isError ? (
            <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-emerald-600" />
            </div>
          )}

          <span className="font-medium text-neutral-800 truncate">
            {meta.label}
          </span>

          {argsSummary && !isRunning && (
            <span className="text-[11px] text-neutral-400 truncate max-w-xs font-mono">
              ({argsSummary})
            </span>
          )}

          {isRunning && (
            <span className="text-[11px] text-neutral-400">正在查询…</span>
          )}
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

      {/* 展开的详情结果 */}
      {isExpanded && !isRunning && (
        <div className="border-t border-neutral-200/80 bg-white p-3">
          {isError ? (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800">
              <div className="font-semibold text-xs mb-1">工具执行失败</div>
              <div className="text-[11px] leading-relaxed">
                {envelope.error?.message || (typeof result === 'string' ? result : '查询遇到未知异常')}
              </div>
            </div>
          ) : (
            <Renderer envelope={envelope} />
          )}
        </div>
      )}
    </div>
  );
};
