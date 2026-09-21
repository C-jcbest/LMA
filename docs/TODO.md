# LMA 待办入口

当前全栈“官方栈优先”重构的权威计划见 [official-stack-refactor.md](official-stack-refactor.md)。后续全栈重构 PR 应优先维护该文档中的问题 ID、证据、迁移状态与验收结果；[重构 TODO.md](重构%20TODO.md) 作为此前前端迁移历史继续保留。

当前核心架构演进与前端重构清单见 [重构 TODO.md](重构%20TODO.md)。
当前系统实现与持续有效决策见 [project-status.md](project-status.md)。
产品口径以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准。

> **历史清单清理说明**：
> - 早期历史清单及临时版本已清理归档。
> - 已完成的基础设施与业务项已沉淀在代码与测试中；前端 assistant-ui 全面重构任务见 [重构 TODO.md](重构%20TODO.md)。

## 近期重要完成项（2026-09-19）

1. **历史摘要消息标准化与折叠展示**：
   - Patch `@assistant-ui/react-langchain` 将 `additional_kwargs?.lc_source === "summarization"` 映射为 `role: "system"`，杜绝作为用户气泡；
   - `ThreadSummaryMessage` 实现抽屉式归档折叠，默认收起并支持点击展开查看纯文本；彻底删除 `SummaryCard.tsx`。
2. **P6：Reasoning / Thinking 与工具同级排版及防抖动优化**：
   - 删除 `ThinkingBlock.tsx`、`ThinkingIndicator.tsx` 与 `components/reasoning.tsx`；
   - 接入 assistant-ui 官方 `Reasoning` Element 与 Primitive，思考触发器去除图标仅保留文本与极淡 Chevron，与工具行统一为 ~28px 紧凑排版；
   - 恢复官方 `isOpen` 流式展开并在 `Collapsible`/`ReasoningRoot` 贯通 `ref` 与 `useScrollLock`，彻底消除折叠展开抖动。
3. **P7：Tool Call 两层单折叠交互、去 ToolGroup 与轻量视觉**：
   - 彻底删除 `ToolGroup`（`tool-group.aui.tsx`）及三层嵌套外壳，Tool 与 Reasoning 成为同级 Sibling Message Part；
   - 每个 Tool 自身作为独立 Collapsible，所有普通工具（含场地环境）默认收起，仅 HITL / `requires-action` 自动展开；
   - 运行中隐藏 Chevron 并禁用折叠，完成后展示耗时与 Chevron，点击展开直接呈现完整业务数据（无第二级折叠）；
   - 消除内部函数名与原始 JSON 调试杂质，Registry 提供状态动词，弱化 Station/GNSS/Weather/Vision 边框与阴影；
   - 严格按 v1 Envelope 解码并校验 `artifactKind`，彻底移除 `parseOutputRecord` 与 JSON 猜测。
4. **P8：Markdown 改用 assistant-ui Streamdown**：
   - 删除 `MarkdownMessage.tsx`，卸载 `react-markdown`、`remark-gfm` 与 `@assistant-ui/react-markdown`；
   - 统一改用 `@assistant-ui/react-streamdown`，保留中文字体样式与代码块复制。
5. **实时工具流式两阶段事件桥接与展示优化**：
   - 新增 `LiveToolEventsProvider`，通过 LangGraph stream tools channel 实时桥接流式工具事件；
   - `ToolFallback` 实行两阶段消费与四态严格互斥渲染（requires-action/incomplete/complete/running）；
   - 优化 `VisionResultView`、`WeatherResultView` 视觉排版与 `Thread.Viewport` 滚动条体验。引入 `@streamdown/code` 插件提供语法高亮，Tailwind v4 注入 `@source` 编译指令，保留排版与复制能力。
   - artifact 消费规则收敛为「持久化 `ToolMessage.artifact` 永远优先，live tools channel artifact 仅作流式阶段兜底」，success / partial / error 一致，确保历史错误业务信息刷新后不丢失；
   - 后端并行工具回归测试改为直接消费生产链路 `stream_mode="tools"` 的 `tool-finished` 事件（而非 `astream_events` 的 `on_tool_end`），与前端 `useChannel(["tools"])` 同源；`live-tool-results.ts` 与 `getEffectiveStatus` 改用官方 `Event` / `AssembledToolCall` 类型，移除 `any`。

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
