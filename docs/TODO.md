# LMA 待办入口

当前核心架构演进与工程化收敛清单见 [TODO_2026-09-18.md](TODO_2026-09-18.md)。
当前系统实现与持续有效决策见 [project-status.md](project-status.md)。
产品口径以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准。

> **历史清单清理说明**：
> - 早期 `TODO_2026-09-14.md`、`TODO_2026-09-15.md` 及重构草稿 `TODO_simplify.md` 已清理归档。
> - 已完成的基础设施与业务项（TODO 1–17, 20 及 P0 简化项）已全数沉淀在代码与测试中；前瞻性架构任务（原 TODO 18–26）已全面收敛重构并纳入 [TODO_2026-09-18.md](TODO_2026-09-18.md)。

---

## 近期重要完成项（2026-09-18）

1. **Stop 完全回归官方生命周期**：
   - 前端 Stop 仅调用 `await stream.stop({ cancel: true })`，彻底删除前端 `RemoveMessage` / `AIMessage` 重构、`threads.updateState`、`stopReconciling`/`stopError` 本地状态机，以及 `streamCompat.ts`（私有 `STREAM_CONTROLLER` API）；
   - 服务端注册 `abefore_agent` 钩子自愈清洗悬空 tool-calls，维护 checkpoint 内部一致性，支持直接提交新 Run。
2. **工具异常与空结果契约收敛**：
   - 接入官方 `ToolErrorMiddleware`，`LmaMiddleware` 仅处理领域异常并注入安全展示 envelope；
   - 统一工具空结果契约（`list_station_groups`、`list_stations`、`get_daily_gnss_data`、`query_weather` 查询结果为空时正常返回成功结构，不抛 `ToolFailure`）。
3. **两阶段逐工具实时展示与完成判定极简化**：
   - 移除对 `liveToolCall.status === 'finished'` 的硬依赖，基于结果是否返回（`hasToolMessageResult || hasLiveOutput`）判定完成；
   - 实时阶段优先展示 `liveToolCall.output`，权威 `ToolMessage.artifact` 到达后平滑覆盖；
   - 集中提取 `parseOutputRecord` 消除零散 JSON 猜测；空结果统一显示“该步骤没有可展示的业务数据”，绝不回退为 loading。
4. **模型调用协议解耦与 Structured Output 重构**：
   - Provider / Vendor / Protocol 解耦（主 Agent 保持 Responses API；Title / Summary / Recommendation / Vision 明确使用 Chat Completions）；
   - Qwen3.7-plus 视觉复核通过 `extra_body={"enable_thinking": False}` 关闭思考，改用官方 `with_structured_output` 消除手工正则/json.loads；
   - 规范所有 `AIMessage` 纯文本读取为 `BaseMessage.text`，严禁 `str(content)`；推荐改用严格 Schema。
5. **静态 Prompt Cache 与业务时间**：
   - 业务时间统一使用 `Asia/Shanghai`；
   - `system.md` 彻底静态化，当前业务时间由 `get_current_time` 工具动态获取，最大化供应商 Prompt Cache 命中率。
