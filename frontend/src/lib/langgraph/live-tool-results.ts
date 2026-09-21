"use client";

import React, { createContext, useContext } from "react";
import {
  useChannel,
  type AnyStream,
  type Event,
} from "@langchain/react";
import { useLangChainStream } from "@assistant-ui/react-langchain";

const EMPTY_EVENTS: readonly Event[] = [];

const LiveToolEventsContext = createContext<readonly Event[]>(EMPTY_EVENTS);

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
}

const TOOL_FINISHED_EVENT = "tool-finished";

interface ToolFinishedPayload {
  event: string;
  tool_call_id: string;
  output: unknown;
}

function isToolFinishedPayload(
  data: unknown,
): data is ToolFinishedPayload {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    record.event === TOOL_FINISHED_EVENT &&
    typeof record.tool_call_id === "string"
  );
}

/**
 * 纯只读 helper：从 tools channel 事件流中查找指定 toolCallId 的 artifact
 * 严格遵照 event.params.data 协议，只接受 tool-finished 事件，
 * 并支持 ToolMessage wire envelope 解包；未找到或非 finished 事件安全返回 undefined。
 */
export function getLiveToolArtifact(
  events: readonly Event[],
  toolCallId: string,
): unknown | undefined {
  if (!events || !toolCallId) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i]?.params?.data;
    if (!isToolFinishedPayload(data)) continue;
    if (data.tool_call_id !== toolCallId) continue;
    return getWireField(data.output, "artifact");
  }
  return undefined;
}

const LiveToolEventsSubscription: React.FC<{
  stream: AnyStream;
  children: (events: readonly Event[]) => React.ReactNode;
}> = ({ stream, children }) => {
  const events = useChannel(stream, ["tools"], undefined, {
    bufferSize: 100,
    replay: false,
  });
  return React.createElement(React.Fragment, null, children(events));
};

const LiveToolEventsStreamProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const stream = useLangChainStream();

  if (!stream) {
    return React.createElement(
      LiveToolEventsContext.Provider,
      { value: EMPTY_EVENTS },
      children,
    );
  }

  return React.createElement(LiveToolEventsSubscription, {
    stream,
    children: (events: readonly Event[]) =>
      React.createElement(
        LiveToolEventsContext.Provider,
        { value: events },
        children,
      ),
  });
};

/**
 * 极薄的只读 tools channel 事件上下文 Provider：
 * 仅通过 useLangChainStream 的公开返回值判断是否挂载 useChannel (replay: false)，
 * 供下游纯函数 getLiveToolArtifact 提取实时未落盘的 artifact 载荷。
 */
export const LiveToolEventsProvider: React.FC<{
  children: React.ReactNode;
  eventsOverride?: readonly Event[];
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
export function useLiveToolEvents(): readonly Event[] {
  return useContext(LiveToolEventsContext);
}
