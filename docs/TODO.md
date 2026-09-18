# LMA 待办入口

当前实施与验收清单见 [TODO_2026-09-15.md](TODO_2026-09-15.md)。旧版 2026-09-14 清单已完成，其补丁方案和旧编号不再适用于官方能力重构，故移除，避免与现行清单冲突。

- TODO 4–17 已完成：TODO 16 完成 Provider 与 Thinking 配置收口（官方 `init_chat_model` + DeepSeek adapter 仅限定主 Agent tool loop + OpenAI Responses API reasoning + profile fail-fast）；TODO 17 完成 Reasoning 展示统一只读官方 Content Blocks（前端仅渲染 contentBlocks，后端删除 `lma_thinking_duration_ms` 与 `perf_counter`）。架构与部署边界见 [ADR 0001](adr/0001-agent-runtime.md)。
- TODO 20 已完成：工具能力与外部 API 边界明确化（不增 scope 枚举，主 Agent 根据目标与证据自主决定调用；`query_weather` 通过自然时间参数查询当前/历史/预报，`forecast_days` 取值 0–16 天，工具描述剥离底层配额与 429 协议重试细节；`inspect_site_environment` 保持单一空间背景调查工具，外部 DEM 与地质网络异常彻底局部隔离，任一失败绝不抹掉另一方有效证据；提示词移除强制查天气的暗示）。
- 2026-09-18 已完成：模型调用协议边界解耦与视觉结构化输出重构（解耦 Provider/Vendor/Protocol；主 Agent 保留 Responses API，Title/Summary/Recommendation/Vision 明确使用 Chat Completions；Qwen3.7-plus 视觉复核通过 `extra_body={"enable_thinking": False}` 关闭思考并改用官方 `with_structured_output` 消除手动正则/json.loads 修补；规范所有 `AIMessage` 文本读取为 `BaseMessage.text`，禁止 `str(content)`；推荐改用 `RecommendationResult` 严格 Schema）。
- 2026-09-18 已完成：工具调用改为真正的逐工具实时展示（继续使用官方 `useToolCalls(stream)`，`liveToolCall.status` 决定 running/finished/error，工具成功返回即显示完成，空结果同样视为成功；工具执行期间优先使用 `liveToolCall.output` 实时展示结果，后续 `ToolMessage.artifact` 到达后作为最终持久化内容补充/覆盖。删除“详细结果同步中”及对 `ToolMessage` 的完成阻塞，不修改后端并行工具执行与流协议）。
- 2026-09-18 已完成（[TODO_simplify.md](TODO_simplify.md) P0-1 ~ P0-4）：彻底简化工具卡完成判定（移除对 `liveToolCall.status === 'finished'` 的硬依赖，根据结果是否产生判断完成；空对象/空数组/null均视为合法成功结果；ToolMessage 自然覆盖实时 output；顶层集中提取 `parseOutputRecord` 消除零散 JSON 猜测）。
- 2026-09-18 已完成（[TODO_simplify.md](TODO_simplify.md) P0-6, P0-7, P1-3 及 TODO 1–3）：Stop 完全回归官方 Stream 生命周期（前端 Stop 仅调用 `stream.stop({ cancel: true })`，删除全部前端 RemoveMessage/AIMessage 重构、`threads.updateState`、`streamCompat.ts` 与 `STREAM_CONTROLLER` 私有 API；服务端 `abefore_agent` 自愈清洗中断遗留的悬空 tool-calls 并用 `RemoveMessage` 维护 state 一致性）；通用工具异常交给官方 `ToolErrorMiddleware`，`LmaMiddleware` 仅处理领域异常并统一为错误结果注入安全展示 envelope；统一工具空结果契约（`list_station_groups`、`list_stations`、`get_daily_gnss_data`、`query_weather` 查询结果为空时正常返回成功结构，不抛 `ToolFailure`）。
- 当前实现与持续有效决策见 [project-status.md](project-status.md)。
