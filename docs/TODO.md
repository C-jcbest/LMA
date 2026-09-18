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
6. **Stream Source of Truth 严格收敛（TODO 14）**：
   - 消息统一唯一只读 `useStream().messages`，包括历史压缩摘要严格从该数组提取，消除对 `stream.values.messages` 的双重依赖；运行状态唯一直读 `isLoading`，工具唯一直读 `useToolCalls`。
7. **App.tsx 领域 Hook 拆分（TODO 17）**：
   - 提取 `useThreadNavigation`、`useThreadDirectory`、`useAuxiliaryRuns` 与 `useThreadActions`四大职责聚焦 Hook；
   - 零新增外部状态库依赖，`App.tsx` 从 635 行大幅精简至约 350 行。
8. **通用聊天 Shell 与领域工具渲染解耦（TODO 18）**：
   - `InlineToolCall.tsx` 收拢为轻量通用 Shell（~190 行）；
   - 独立解耦 `StationResultView`、`GnssResultView`、`WeatherResultView`、`VisionResultView`、`SiteEnvironmentResultView` 与 `EmptyOrGenericResultView`，保持 100% 格式与向后兼容测试通过。
9. **前端架构全面改造与 Radix UI / Tool Protocol 落地（2026-09-18）**：
   - 引入 Radix UI Primitives（Dialog、AlertDialog、DropdownMenu、Popover、Tooltip）替换手写脆弱浮层；
   - Tool Artifact 契约版本化（v1 Envelope 包含 `schemaVersion`、`kind`、`data`、`sources`、`limitations`、`observedAt`）与前端 Tool Registry 解耦分发；
   - ChatWindow 拆分为 Header、Viewport、UserMessage、AssistantTurn、MessageList、NextActions、RunStatusBar、Composer 8 个独立组件；
   - 会话标题生成生命周期彻底收敛至服务端 `LmaMiddleware.aafter_agent` 异步更新 thread metadata，消除前端独立 title run；
   - 思考卡片默认折叠，文案规范为“已思考” / “正在思考…”，消除伪造计时器；
   - 全套后端测试（68/68）与前端测试（76/76）及生产构建（`pnpm run build`）全绿通过。
10. **前端架构全面升级至 Frontend V2 (@assistant-ui/react + React 19 + Tailwind 4)（2026-09-19）**：
    - 完整落地 `docs/LMA_FRONTEND_V2_ASSISTANT_UI_PLAN.md`（Phase 0 ~ Phase 7）；
    - 升级至 React 19.3、Tailwind 4、Vite 8、@assistant-ui/react 0.15、@assistant-ui/react-langchain 0.0.32、TanStack Query 5、React Router 7；
    - 采用 `useStreamRuntime` 作为对话核心，唯一通过 URL 获取 `threadId`，彻底消除前端私有状态机；
    - 实现统一 ToolFallback 外壳与 5 大领域监测渲染器（GNSS、天气、测点列表、现场视觉大图弹窗、站点地形地貌与 MapLibre 地图）；
    - 会话列表采用 TanStack Query 无限分页与 Mutation，支持搜索、重命名模态框与删除确认；
    - 支持 LangGraph Human-in-the-loop (HITL) 中断交互确认；
    - 新增 Dockerfile 生产多阶段构建与 Nginx 反向代理配置；
    - 全套前后端测试 156 项（前端 88 项、后端 68 项）与 Vite 生产构建全绿通过。
