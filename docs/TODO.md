# LMA 待办入口

当前实施与验收清单见 [TODO_2026-09-15.md](TODO_2026-09-15.md)。旧版 2026-09-14 清单已完成，其补丁方案和旧编号不再适用于官方能力重构，故移除，避免与现行清单冲突。

- TODO 4–17 已完成：TODO 16 完成 Provider 与 Thinking 配置收口（官方 `init_chat_model` + DeepSeek adapter 仅限定主 Agent tool loop + OpenAI Responses API reasoning + profile fail-fast）；TODO 17 完成 Reasoning 展示统一只读官方 Content Blocks（前端仅渲染 contentBlocks，后端删除 `lma_thinking_duration_ms` 与 `perf_counter`）。架构与部署边界见 [ADR 0001](adr/0001-agent-runtime.md)。
- 当前实现与持续有效决策见 [project-status.md](project-status.md)。
