import React, { useState } from "react";
import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import {
  ToolFallback,
  offersInterruptAction,
} from "@/components/assistant-ui/elements/tool-fallback.aui";
import * as ToolFallbackModule from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  getLiveToolArtifact,
  LiveToolEventsProvider,
} from "@/lib/langgraph/live-tool-results";
import { mockUseLangChainToolCalls } from "./setup";

const TestAuiWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const runtime = useLocalRuntime({});
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

describe("真实 Tools Channel Bridge 与同批工具异步流 (P7)", () => {
  it("删除 ToolFallbackArgs、ToolFallbackResult 与 formatUnknownValue 死代码", () => {
    // 1. 命名空间挂载移除
    expect((ToolFallback as any).Args).toBeUndefined();
    expect((ToolFallback as any).Result).toBeUndefined();
    expect((ToolFallback as any).Error).toBeUndefined();

    // 2. 模块导出移除
    expect((ToolFallbackModule as any).ToolFallbackArgs).toBeUndefined();
    expect((ToolFallbackModule as any).ToolFallbackResult).toBeUndefined();
    expect((ToolFallbackModule as any).ToolFallbackError).toBeUndefined();
    expect((ToolFallbackModule as any).formatUnknownValue).toBeUndefined();

    // 3. 保留必要导出与子组件
    expect(ToolFallback.Root).toBeDefined();
    expect(ToolFallback.Trigger).toBeDefined();
    expect(ToolFallback.Content).toBeDefined();
    expect(ToolFallback.Approval).toBeDefined();
    expect(offersInterruptAction).toBeDefined();
  });

  it("HITL 状态边界：requires-action 不会被 live tool 的 running 状态意外冲掉，且转为 running 后内容区禁止渲染空数据文案", () => {
    // 模拟 liveToolCall 为 running 态
    mockUseLangChainToolCalls.mockReturnValue([
      { id: "hitl-call-1", name: "dangerous_action", status: { type: "running" } },
    ]);

    // 1. requires-action 状态：即便 liveToolCall 为 running，也绝对不能冲掉 requires-action，必须自动展开并显示决策按钮
    const { rerender } = render(
      <TestAuiWrapper>
        <ToolFallback
          toolName="dangerous_action"
          toolCallId="hitl-call-1"
          status={{ type: "requires-action", reason: "approval" } as any}
          argsText="{}"
          approval={{
            id: "appr-1",
            type: "approval",
            decision: "pending",
            prompt: "是否允许执行高风险业务监测操作？",
          } as any}
        />
      </TestAuiWrapper>
    );

    expect(screen.getByText("是否允许执行高风险业务监测操作？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许" })).toBeInTheDocument();

    // 2. 用户决策后，status 转为 running 状态
    // 关键断言：即使此时面板保持 open，内容区绝不能渲染“未查询到符合条件的业务监测数据。”
    rerender(
      <TestAuiWrapper>
        <ToolFallback
          toolName="dangerous_action"
          toolCallId="hitl-call-1"
          status={{ type: "running" } as any}
          argsText="{}"
        />
      </TestAuiWrapper>
    );

    expect(screen.queryByText("未查询到符合条件的业务监测数据。")).not.toBeInTheDocument();
    expect(screen.queryByText("已完成辅助信息查询并同步至模型上下文。")).not.toBeInTheDocument();
  });

  it("getLiveToolArtifact 纯查找 helper 从 tools channel 中提取指定 toolCallId 的 artifact", () => {
    const sampleEvents: any[] = [
      {
        params: {
          data: {
            event: "tool-started",
            tool_call_id: "call-1",
            tool_name: "list_stations",
          },
        },
      },
      {
        params: {
          data: {
            event: "tool-finished",
            tool_call_id: "call-1",
            tool_name: "list_stations",
            output: {
              type: "tool",
              content: "站点数据",
              artifact: {
                version: 1,
                kind: "station_list",
                status: "success",
                data: { stations: [{ station_name: "测点A" }] },
              },
            },
          },
        },
      },
      {
        params: {
          data: {
            event: "tool-finished",
            tool_call_id: "call-2",
            tool_name: "get_weather",
            output: {
              type: "tool",
              content: "无 artifact 输出",
            },
          },
        },
      },
    ];

    // 1. 成功提取对应 toolCallId 的 artifact
    const artifact1 = getLiveToolArtifact(sampleEvents, "call-1");
    expect(artifact1).toEqual({
      version: 1,
      kind: "station_list",
      status: "success",
      data: { stations: [{ station_name: "测点A" }] },
    });

    // 2. 存在事件但无 output.artifact，返回 undefined
    const artifact2 = getLiveToolArtifact(sampleEvents, "call-2");
    expect(artifact2).toBeUndefined();

    // 3. 不存在的 toolCallId，返回 undefined
    const artifact3 = getLiveToolArtifact(sampleEvents, "call-not-exist");
    expect(artifact3).toBeUndefined();

    // 4. 空数组或无 toolCallId，安全返回 undefined
    expect(getLiveToolArtifact([], "call-1")).toBeUndefined();
    expect(getLiveToolArtifact(sampleEvents, "")).toBeUndefined();
  });

  it("ToolFallback 对独立工具状态更新正确渲染", async () => {
    vi.useFakeTimers();

    try {
      const TestParallelContainer: React.FC = () => {
        const [activeCalls, setActiveCalls] = useState<any[]>([
          { id: "call-1", name: "list_stations", status: { type: "running" } },
          { id: "call-2", name: "list_station_groups", status: { type: "running" } },
          { id: "call-3", name: "get_daily_gnss_data", status: { type: "running" } },
        ]);

        mockUseLangChainToolCalls.mockReturnValue(activeCalls);

        React.useEffect(() => {
          // 100ms: A 完成
          const t1 = setTimeout(() => {
            setActiveCalls((prev) => [
              { id: "call-1", name: "list_stations", status: { type: "finished" } },
              prev[1],
              prev[2],
            ]);
          }, 100);

          // 500ms: B 完成
          const t2 = setTimeout(() => {
            setActiveCalls((prev) => [
              prev[0],
              { id: "call-2", name: "list_station_groups", status: { type: "finished" } },
              prev[2],
            ]);
          }, 500);

          // 1000ms: C 完成
          const t3 = setTimeout(() => {
            setActiveCalls((prev) => [
              prev[0],
              prev[1],
              { id: "call-3", name: "get_daily_gnss_data", status: { type: "finished" } },
            ]);
          }, 1000);

          return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearTimeout(t3);
          };
        }, []);

        return (
          <div data-slot="parallel-tools">
            <ToolFallback
              toolName="list_stations"
              toolCallId="call-1"
              status={{ type: "running" }}
              argsText="{}"
            />
            <ToolFallback
              toolName="list_station_groups"
              toolCallId="call-2"
              status={{ type: "running" }}
              argsText="{}"
            />
            <ToolFallback
              toolName="get_daily_gnss_data"
              toolCallId="call-3"
              status={{ type: "running" }}
              argsText="{}"
            />
          </div>
        );
      };

      render(
        <TestAuiWrapper>
          <TestParallelContainer />
        </TestAuiWrapper>
      );

      // 0ms：三者均为运行态，禁用交互
      expect(screen.getByRole("button", { name: /正在查询监测点信息…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在查询监测点分组…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 前进 100ms：A 依据 live tool calls 率先 finished，B/C 仍 running
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const btnA = screen.getByRole("button", { name: /已查询监测点信息/ });
      expect(btnA).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在查询监测点分组…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 前进 400ms（到达 500ms）：B finished，C 仍 running
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(screen.getByRole("button", { name: /已查询监测点信息/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /已查询监测点分组/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 前进 500ms（到达 1000ms）：C finished，全部工具完成
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(screen.getByRole("button", { name: /已获取 GNSS 监测数据/ })).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("真实 LangGraph tools-channel 测试：同批并行工具按 100ms/500ms/1000ms 异步完成，无需等待最慢工具", async () => {
    vi.useFakeTimers();

    try {
      const TestAgentToolsStream: React.FC = () => {
        const [activeCalls, setActiveCalls] = useState<any[]>([
          { id: "call-quick", name: "list_stations", status: { type: "running" } },
          { id: "call-medium", name: "list_station_groups", status: { type: "running" } },
          { id: "call-slow", name: "get_daily_gnss_data", status: { type: "running" } },
        ]);

        const [toolEvents, setToolEvents] = useState<any[]>([]);

        mockUseLangChainToolCalls.mockReturnValue(activeCalls);

        React.useEffect(() => {
          // 100ms: Quick tool 完成并写入 tools channel 事件
          const t1 = setTimeout(() => {
            setToolEvents((prev) => [
              ...prev,
              {
                params: {
                  data: {
                    event: "tool-finished",
                    tool_call_id: "call-quick",
                    tool_name: "list_stations",
                    output: {
                      artifact: {
                        version: 1,
                        kind: "station_list",
                        status: "success",
                        data: { stations: [{ station_name: "测点快" }] },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              { id: "call-quick", name: "list_stations", status: { type: "finished" } },
              prev[1],
              prev[2],
            ]);
          }, 100);

          // 500ms: Medium tool 完成
          const t2 = setTimeout(() => {
            setToolEvents((prev) => [
              ...prev,
              {
                params: {
                  data: {
                    event: "tool-finished",
                    tool_call_id: "call-medium",
                    tool_name: "list_station_groups",
                    output: {
                      artifact: {
                        version: 1,
                        kind: "station_group_list",
                        status: "success",
                        data: { groups: [{ group_name: "分组中" }] },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              prev[0],
              { id: "call-medium", name: "list_station_groups", status: { type: "finished" } },
              prev[2],
            ]);
          }, 500);

          // 1000ms: Slow tool 完成
          const t3 = setTimeout(() => {
            setToolEvents((prev) => [
              ...prev,
              {
                params: {
                  data: {
                    event: "tool-finished",
                    tool_call_id: "call-slow",
                    tool_name: "get_daily_gnss_data",
                    output: {
                      artifact: {
                        version: 1,
                        kind: "gnss_data",
                        status: "success",
                        data: { station_name: "测点慢", records: [] },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              prev[0],
              prev[1],
              { id: "call-slow", name: "get_daily_gnss_data", status: { type: "finished" } },
            ]);
          }, 1000);

          return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearTimeout(t3);
          };
        }, []);

        return (
          <LiveToolEventsProvider eventsOverride={toolEvents}>
            <div data-slot="agent-stream-tools">
              <ToolFallback
                toolName="list_stations"
                toolCallId="call-quick"
                status={{ type: "running" }}
                argsText="{}"
              />
              <ToolFallback
                toolName="list_station_groups"
                toolCallId="call-medium"
                status={{ type: "running" }}
                argsText="{}"
              />
              <ToolFallback
                toolName="get_daily_gnss_data"
                toolCallId="call-slow"
                status={{ type: "running" }}
                argsText="{}"
              />
            </div>
          </LiveToolEventsProvider>
        );
      };

      render(
        <TestAuiWrapper>
          <TestAgentToolsStream />
        </TestAuiWrapper>
      );

      // 0ms：三个工具都在运行
      expect(screen.getByRole("button", { name: /正在查询监测点信息…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在查询监测点分组…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 100ms 时：第一个工具 complete，其余两个仍为 running
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByRole("button", { name: /已查询监测点信息/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在查询监测点分组…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 500ms 时：第二个工具 complete，第三个仍为 running
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(screen.getByRole("button", { name: /已查询监测点信息/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /已查询监测点分组/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      // 1000ms 时：第三个工具 complete，全部完成
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(screen.getByRole("button", { name: /已查询监测点信息/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /已查询监测点分组/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /已获取 GNSS 监测数据/ })).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
