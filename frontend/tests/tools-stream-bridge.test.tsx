import React, { useState } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
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

  it("getEffectiveStatus 终态优先级：Message Part 处于终态时永远以 Message Part 为准，不被 live 状态覆盖", () => {
    // 模拟 liveToolCall 因函数运行结束而呈现 finished
    mockUseLangChainToolCalls.mockReturnValue([
      { id: "call-err-1", name: "get_daily_gnss_data", status: "finished" },
    ]);

    // 但底座 Message Part 已确立错误终态 (incomplete/error)
    const { container } = render(
      <TestAuiWrapper>
        <ToolFallback
          toolName="get_daily_gnss_data"
          toolCallId="call-err-1"
          status={{ type: "incomplete", error: "未找到指定监测点，请确认站点。" }}
          argsText="{}"
        />
      </TestAuiWrapper>
    );

    // 关键断言：终态以 Message Part 为准，显示错误而不是 liveToolCall 的成功 complete
    expect(screen.getByRole("button", { name: /GNSS 数据获取失败/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已获取 GNSS 监测数据/ })).not.toBeInTheDocument();

    // 打开内容区：展示错误原因，绝对不能显示“未查询到符合条件的业务监测数据。”
    fireEvent.click(screen.getByRole("button", { name: /GNSS 数据获取失败/ }));
    expect(screen.getByText("未找到指定监测点，请确认站点。")).toBeInTheDocument();
    expect(screen.queryByText("未查询到符合条件的业务监测数据。")).not.toBeInTheDocument();
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

  it("getLiveToolArtifact 严格支持 ToolMessage wire envelope (artifact / kwargs / lc_kwargs) 且仅接受 tool-finished 事件", () => {
    const sampleEvents: any[] = [
      // 1. started 事件应被跳过
      {
        params: {
          data: {
            event: "tool-started",
            tool_call_id: "call-1",
            tool_name: "list_stations",
          },
        },
      },
      // 2. 标准 output.artifact
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
      // 3. LangGraph wire envelope: output.kwargs.artifact
      {
        params: {
          data: {
            event: "tool-finished",
            tool_call_id: "call-kwargs",
            tool_name: "list_station_groups",
            output: {
              kwargs: {
                artifact: {
                  version: 1,
                  kind: "station_list",
                  status: "success",
                  data: { groups: [{ group_name: "分组K" }] },
                },
              },
            },
          },
        },
      },
      // 4. LangGraph wire envelope: output.lc_kwargs.artifact
      {
        params: {
          data: {
            event: "tool-finished",
            tool_call_id: "call-lc-kwargs",
            tool_name: "get_daily_gnss_data",
            output: {
              lc_kwargs: {
                artifact: {
                  version: 1,
                  kind: "gnss_series",
                  status: "success",
                  data: { station_name: "测点LC", points: [] },
                },
              },
            },
          },
        },
      },
      // 5. 无 artifact 的 finished 事件
      {
        params: {
          data: {
            event: "tool-finished",
            tool_call_id: "call-no-artifact",
            tool_name: "get_weather",
            output: {
              content: "无 artifact 输出",
            },
          },
        },
      },
    ];

    // 标准 artifact
    expect(getLiveToolArtifact(sampleEvents, "call-1")).toEqual({
      version: 1,
      kind: "station_list",
      status: "success",
      data: { stations: [{ station_name: "测点A" }] },
    });

    // kwargs.artifact
    expect(getLiveToolArtifact(sampleEvents, "call-kwargs")).toEqual({
      version: 1,
      kind: "station_list",
      status: "success",
      data: { groups: [{ group_name: "分组K" }] },
    });

    // lc_kwargs.artifact
    expect(getLiveToolArtifact(sampleEvents, "call-lc-kwargs")).toEqual({
      version: 1,
      kind: "gnss_series",
      status: "success",
      data: { station_name: "测点LC", points: [] },
    });

    // 无 artifact
    expect(getLiveToolArtifact(sampleEvents, "call-no-artifact")).toBeUndefined();

    // 不存在的 tool_call_id
    expect(getLiveToolArtifact(sampleEvents, "call-not-exist")).toBeUndefined();
    expect(getLiveToolArtifact([], "call-1")).toBeUndefined();
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

  it("tools-channel bridge：模拟独立 tool-finished 事件时，各工具独立完成", async () => {
    vi.useFakeTimers();

    try {
      const TestAgentToolsStream: React.FC = () => {
        const [activeCalls, setActiveCalls] = useState<any[]>([
          { id: "call-quick", name: "list_stations", status: "running" },
          { id: "call-medium", name: "list_station_groups", status: "running" },
          { id: "call-slow", name: "get_daily_gnss_data", status: "running" },
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
                        data: { stations: [{ station_name: "测点快", station_status: "正常" }] },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              { id: "call-quick", name: "list_stations", status: "finished" },
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
                        kind: "station_list",
                        status: "success",
                        data: { groups: [{ group_name: "分组中", station_count: 5 }] },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              prev[0],
              { id: "call-medium", name: "list_station_groups", status: "finished" },
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
                        kind: "gnss_series",
                        status: "success",
                        data: {
                          station_name: "测点慢",
                          points: [{ time: "2026-09-20 12:00:00", n: 1.234, e: 2.345, u: 3.456 }],
                        },
                      },
                    },
                  },
                },
              },
            ]);
            setActiveCalls((prev) => [
              prev[0],
              prev[1],
              { id: "call-slow", name: "get_daily_gnss_data", status: "finished" },
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

      // 100ms 时：第一个工具 complete，点击展开后必须渲染出业务数据“测点快”！
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const btnA = screen.getByRole("button", { name: /已查询监测点信息/ });
      expect(btnA).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在查询监测点分组…/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      fireEvent.click(btnA);
      expect(screen.getByText("测点快")).toBeInTheDocument();

      // 500ms 时：第二个工具 complete，点击展开后必须渲染出业务数据“分组中”！
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      const btnB = screen.getByRole("button", { name: /已查询监测点分组/ });
      expect(btnB).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

      fireEvent.click(btnB);
      expect(screen.getByText("分组中")).toBeInTheDocument();

      // 1000ms 时：第三个工具 complete，点击展开后必须渲染出业务数据“测点慢”！
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      const btnC = screen.getByRole("button", { name: /已获取 GNSS 监测数据/ });
      expect(btnC).not.toBeDisabled();

      fireEvent.click(btnC);
      expect(screen.getByText("测点慢")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
