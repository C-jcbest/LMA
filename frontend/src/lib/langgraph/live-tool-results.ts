"use client";

import React, { createContext, useContext } from "react";
import { useChannel, STREAM_CONTROLLER, type AnyStream } from "@langchain/react";
import { useLangChainStream } from "@assistant-ui/react-langchain";

const EMPTY_EVENTS: readonly any[] = [];

const LiveToolEventsContext = createContext<readonly any[]>(EMPTY_EVENTS);

/**
 * 纯只读 helper：从 tools channel 事件流中纯查找指定 toolCallId 的 artifact
 * 遍历 tools channel 事件，找到 event.params.data.tool_call_id === toolCallId，
 * 返回 event.params.data.output?.artifact；找不到返回 undefined。
 */
export function getLiveToolArtifact(
  events: readonly any[],
  toolCallId: string,
): unknown | undefined {
  if (!events || !toolCallId) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const data = event?.params?.data ?? event?.data;
    if (data && data.tool_call_id === toolCallId) {
      return data.output?.artifact;
    }
  }
  return undefined;
}

const LiveToolEventsSubscription: React.FC<{
  stream: AnyStream;
  children: (events: readonly any[]) => React.ReactNode;
}> = ({ stream, children }) => {
  const events = useChannel(stream, ["tools"], undefined, { bufferSize: 100 });
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
 * 仅在存在有效 AnyStream 实例时挂载 useChannel，
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
