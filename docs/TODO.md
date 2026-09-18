# LMA 待办入口

当前实施与验收清单见 [TODO_2026-09-15.md](TODO_2026-09-15.md)。旧版 2026-09-14 清单已完成，其补丁方案和旧编号不再适用于官方能力重构，故移除，避免与现行清单冲突。

- TODO 4–17 已完成：TODO 16 完成 Provider 与 Thinking 配置收口（官方 `init_chat_model` + DeepSeek adapter 仅限定主 Agent tool loop + OpenAI Responses API reasoning + profile fail-fast）；TODO 17 完成 Reasoning 展示统一只读官方 Content Blocks（前端仅渲染 contentBlocks，后端删除 `lma_thinking_duration_ms` 与 `perf_counter`）。架构与部署边界见 [ADR 0001](adr/0001-agent-runtime.md)。
- TODO 20 已完成：工具能力与外部 API 边界明确化（不增 scope 枚举，主 Agent 根据目标与证据自主决定调用；`query_weather` 通过自然时间参数查询当前/历史/预报，`forecast_days` 取值 0–16 天，工具描述剥离底层配额与 429 协议重试细节；`inspect_site_environment` 保持单一空间背景调查工具，外部 DEM 与地质网络异常彻底局部隔离，任一失败绝不抹掉另一方有效证据；提示词移除强制查天气的暗示）。
- 2026-09-18 已完成：模型调用协议边界解耦与视觉结构化输出重构（解耦 Provider/Vendor/Protocol；主 Agent 保留 Responses API，Title/Summary/Recommendation/Vision 明确使用 Chat Completions；Qwen3.7-plus 视觉复核通过 `extra_body={"enable_thinking": False}` 关闭思考并改用官方 `with_structured_output` 消除手动正则/json.loads 修补；规范所有 `AIMessage` 文本读取为 `BaseMessage.text`，禁止 `str(content)`；推荐改用 `RecommendationResult` 严格 Schema）。
- 2026-09-18 已完成：工具调用状态实时化（保持现有 LangGraph 与 `useToolCalls(stream)` 官方实现不变，仅修改 `InlineToolCall` 状态判断。`liveToolCall.status` 作为运行时状态来源，收到 `finished/error` 后立即更新对应工具 UI；`ToolMessage` 不再作为工具完成的必要条件，仅负责最终持久化结果与 artifact（图表、地图、详细数据）展示。保持并行 Tool Calling，不增加自定义流协议）。
- 当前实现与持续有效决策见 [project-status.md](project-status.md)。
