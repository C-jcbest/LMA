"use client";

import React, { createContext, useContext } from "react";
import { useChannel, STREAM_CONTROLLER, type AnyStream } from "@langchain/react";
import { useLangChainStream } from "@assistant-ui/react-langchain";

const EMPTY_EVENTS: readonly any[] = [];

const LiveToolEventsContext = createContext<readonly any[]>(EMPTY_EVENTS);

/**
 * 协议字段解包辅助函数：
 * 支持 LangGraph SDK 官方处理 ToolMessage 时的标准 wire envelope 结构
 * (value[field] / value.kwargs[field] / value.lc_kwargs[field])
 */
function getWireField(
  value: unknown,
  field: string,
): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (field in record) {
    return record[field];
  }
  const kwargs = record.kwargs;
  if (
    kwargs &&
    typeof kwargs === "object" &&
    !Array.isArray(kwargs) &&
    field in kwargs
  ) {
    return (kwargs as Record<string, unknown>)[field];
  }
  const lcKwargs = record.lc_kwargs;
  if (
    lcKwargs &&
    typeof lcKwargs === "object" &&
    !Array.isArray(lcKwargs) &&
    field in lcKwargs
  ) {
    return (lcKwargs as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * 纯只读 helper：从 tools channel 事件流中纯查找指定 toolCallId 的 artifact
 * 严格遵照 event.params.data 协议，只接受 tool-finished 事件，
 * 并支持 ToolMessage wire envelope 解包；未找到或非 finished 事件安全返回 undefined。
 */
export function getLiveToolArtifact(
  events: readonly any[],
  toolCallId: string,
): unknown | undefined {
  if (!events || !toolCallId) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i]?.params?.data as
      | Record<string, unknown>
      | undefined;
    if (
      data?.event !== "tool-finished" ||
      data.tool_call_id !== toolCallId
    ) {
      continue;
    }
    return getWireField(data.output, "artifact");
  }
  return undefined;
}

const LiveToolEventsSubscription: React.FC<{
  stream: AnyStream;
  children: (events: readonly any[]) => React.ReactNode;
}> = ({ stream, children }) => {
  const events = useChannel(stream, ["tools"], undefined, {
    bufferSize: 100,
    replay: false,
  });
  return React.createElement(React.Fragment, null, children(events));
};

const LiveToolEventsStreamProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const stream = useLangChainStream();
  const hasValidStream = Boolean(
    stream && typeof stream === "object" && (stream as any)[STREAM_CONTROLLER],
  );

  if (!hasValidStream) {
    return React.createElement(
      LiveToolEventsContext.Provider,
      { value: EMPTY_EVENTS },
      children,
    );
  }

  return React.createElement(LiveToolEventsSubscription, {
    stream: stream as AnyStream,
    children: (events: readonly any[]) =>
      React.createElement(
        LiveToolEventsContext.Provider,
        { value: events },
        children,
      ),
  });
};

/**
 * 极薄的只读 tools channel 事件上下文 Provider：
 * 仅在存在有效 AnyStream 实例时挂载 useChannel (replay: false)，
 * 供下游纯函数 getLiveToolArtifact 提取实时未落盘的 artifact 载荷。
 */
export const LiveToolEventsProvider: React.FC<{
  children: React.ReactNode;
  eventsOverride?: readonly any[];
}> = ({ children, eventsOverride }) => {
  if (eventsOverride) {
    return React.createElement(
      LiveToolEventsContext.Provider,
      { value: eventsOverride },
      children,
    );
  }
  return React.createElement(LiveToolEventsStreamProvider, null, children);
};

/**
 * 读取当前 tools channel 的最新事件列表
 */
export function useLiveToolEvents(): readonly any[] {
  return useContext(LiveToolEventsContext);
}
