# 项目状态与有效决策

更新：2026-09-19。只保留当前系统权威实现、持续有效决策、临时兼容边界与验证基线。
产品口径以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准，活跃演进待办以 [现行待办入口](TODO.md) 与 [重构 TODO.md](重构%20TODO.md) 为准。

---

## 一、当前系统实现

### 1. 后端 Agent Runtime
- **主图工厂**：`backend/app/agent/graph.py:graph` 基于 LangChain 官方 `create_agent` 构建，负责 ReAct 循环与工具并行执行。
- **官方 Middleware 统一装配**：
  - `SummarizationMiddleware`：Token 驱动（默认 800k trigger / 400k keep）长上下文管理，保留官方 nostream 标签与安全切点；
  - `ModelRetryMiddleware` / `ToolRetryMiddleware`：仅针对网络超时/中断及 408/429/5xx 瞬时异常退避重试，底层 SDK 禁用重试；
  - `ModelCallLimitMiddleware`（默认 20 次）/ `ToolCallLimitMiddleware`（默认 40 次）：逻辑调用限额控制；
  - `ToolErrorMiddleware`：统一捕获非受控异常并转换为安全脱敏错误文案，放行领域异常。
- **LMA 领域扩展极简化与单标题所有权**：
  - `LmaMiddleware` 仅承担业务时间锚点装配、`context_usage` 统计展示、回答完成后单次推荐触发，以及领域异常（`ToolFailure`）的安全展示 envelope；
  - 彻底删除后端 `_maybe_auto_title`，标题生成统一收敛至前端 assistant-ui Adapter 生命周期，由无状态图 `session-title` 处理并持久化到 `thread.metadata.name`；
  - 彻底删除通用异常兜底与多余的重试/调度逻辑。
- **服务端 Stop 自愈**：
  - 注册 `abefore_agent` 钩子 `_sanitize_unanswered_tool_calls`；
  - 在当前 Run 启动前扫描 checkpoint 中的消息，利用官方 `RemoveMessage` 清除全未完成的悬空 AI tool-call 消息，原位收窄部分完成批次，确保模型节点绝不接收未配对的 tool-calls。

### 2. 前端架构与交互
- **assistant-ui 唯一运行时体系（P2 落地）**：
  - 采用标准单向数据流：`assistant-ui runtime` ↓ `@assistant-ui/react-langchain` (`useStreamRuntime`) ↓ `@langchain/react useStream` ↓ `LangGraph Server`；
  - 前端通用聊天 Thread、Message、Composer、ActionBar、Reasoning、Tool Call 生命周期与 Thread List 完全由 assistant-ui 官方 Primitives 与 Elements 接管；
  - `App.tsx` 纯声明式装配收敛至 ~40 行，彻底删除了旧 `useStream` 手写流控与消息状态机。
- **现代 AppLayout 布局与旧 Hooks 彻底清理**：
  - 采用左侧 260px Sidebar（内嵌 `ThreadList`）+ 右侧聊天主视口（内嵌 `Thread`）；
  - 彻底删除旧的四个会话 Hook（`useThreadNavigation`、`useThreadDirectory`、`useAuxiliaryRuns`、`useThreadActions`）及 `services/api.ts` 中的旧会话目录函数（`ThreadSession`、`getSessions`、`getBusySessions`、`mergeSessions`）。
- **会话管理与 Canonical ID 对齐（P3 落地）**：
  - 唯一适配器 `createLangGraphThreadListAdapter` 严格满足 `remoteId === externalId === thread.thread_id`，保证会话列表选择态与底层 Checkpoint/Stream 完全对齐；
  - 分页使用官方 `ThreadListPrimitive.LoadMore`，由 assistant-ui 自行管理 `nextCursor` 调度；
  - 会话标题由 Adapter 的 `generateTitle()` 生命周期托管，异步调用 `session-title` 图生成并回写，杜绝前后端双标题竞态。
- **URL 驱动与 controlled 模式**：
  - `AssistantProvider` 作为薄适配层，将 `urlThreadId` 与 `handleThreadIdChange` 传入 `useStreamRuntime`；
  - 通过 `pnpm patch` 修复了 `@assistant-ui/react-langchain@0.0.32` 遗漏向底层 `useRemoteThreadListRuntime` 透传 `threadId` 的上游缺陷，完全依靠 assistant-ui 官方 controlled 机制驱动切换；
  - 彻底删除了手写 `switchToThread` 的副作用与冗余 external props，UI 会话切换主动驱动 `pushState` 保证浏览器前进/后退（`popstate`）真实可用，支持刷新保留与 URL 分享，不维护额外状态机。
- **前端基础技术栈升级（P1 落地）**：
  - 全面升级至 React 19.3 + Vite 8.3 + TypeScript 7.0 + Tailwind v4.3.3；
  - 声明 `packageManager: "pnpm@10.30.3"` 与 `engines: { "node": "^20.19.0 || >=22.12.0" }`，提供 `.nvmrc`；
  - 在 `index.css` 的 `@theme inline` 中完整注册 shadcn 所需的 `--color-*` 与 collapsible 折叠动画 tokens。
- **官方 Thread Element 全面替换旧聊天壳（P4 落地）**：
  - 彻底删除旧版 `ChatWindow.tsx`、`components/chat/*`（8 个组件）、`MessageActions.tsx`、`OptimisticMessageStatus.tsx` 共 11 个旧文件及目录；
  - 官方 `Thread` Element 直接驱动 Message List、Composer、Auto-scroll、Scroll-to-bottom、Welcome 等核心交互，无冗余聊天容器；
  - 视觉样式精准对齐：`--thread-max-width: 56rem`（即 `max-w-4xl`），正文式 Assistant Message，极简边框与轻量阴影；
  - 欢迎界面（`ThreadWelcome`）全面中文化，精准引导滑坡监测业务。
- **Composer 完全回归 assistant-ui 与业务功能扩展（P5 落地）**：
  - 彻底移除 `inputText`、`textareaRef`、IME 手写控制、自动高度与手工 Send/Stop 状态切换等脆弱逻辑；
  - 依托 assistant-ui 官方 `ComposerPrimitive` 驱动生命周期，占位符对齐业务：“询问监测数据、变化趋势、降雨关联或场地环境…”；
  - 左侧新增业务快捷提问菜单（`ComposerQuickActions`），呼出标准监测问题（测点稳定性、降雨天气关联、趋势对比、分组台账）并无缝填充；
  - 右侧通过官方 `useLangChainState("context_usage")` 原生嵌入 `ContextUsageIndicator`，实时反映模型上下文窗口占用；
  - 欢迎界面集成一键快捷提问胶囊按钮。
- **历史摘要消息标准化与折叠展示**：
  - 通过 patch `@assistant-ui/react-langchain` 将 `additional_kwargs?.lc_source === "summarization"` 消息映射为 `role: "system"`，彻底杜绝历史摘要展示为用户消息气泡；
  - `thread.aui.tsx` 中新增 `ThreadSummaryMessage`（归档折叠卡片），默认收起，提示“更早的对话已压缩为摘要”，点击可展开查看摘要纯文本；
  - 彻底删除旧版 `SummaryCard.tsx`。
- **Reasoning / Thinking 与工具同级排版及防抖动优化（P6 落地）**：
  - 彻底删除 `ThinkingBlock.tsx`、`ThinkingIndicator.tsx` 与 `components/reasoning.tsx`；
  - 基于 assistant-ui 官方 `Reasoning` Element 与 Primitive 接管生命周期，触发器去除图标仅保留纯文本与极淡 Chevron，与工具行统一度量（~28px 紧凑风格）；
  - 恢复官方 `isOpen` 行为（流式中自动展开，结束后恢复折叠）；
  - 在 `Collapsible` 与 `ReasoningRoot` 中正确透传 DOM `ref`，并结合 `useScrollLock` 彻底消除视口展开折叠抖动；
  - 状态汉化对齐为 `正在思考…`（流式运行）与 `已思考`（终态），消除伪造思考耗时。
- **Tool Call 两层单折叠交互、去 ToolGroup 与轻量视觉（P7 落地）**：
  - 彻底删除 `ToolGroup`（`tool-group.aui.tsx`）及三层嵌套外壳，Tool 与 Reasoning 成为同级 Sibling Message Part；
  - 每个 Tool 自身作为独立 Collapsible，所有普通工具（含场地环境）默认收起，仅 HITL / `requires-action` 自动展开；
  - 运行中隐藏 Chevron 并禁用折叠，完成后展示真实耗时与 Chevron，用户点击后直接展示完整业务数据（无第二级折叠）；
  - 彻底消除内部函数名（如 `(get_daily_gnss_data)`）与原始 args/result JSON 调试杂质，Registry 提供状态动词（如 `正在获取 GNSS 监测数据…` / `已获取 GNSS 监测数据`）；
  - 业务展示组件（`features/monitoring/tools/`）弱化边框与阴影，采用极简无阴影卡片与表格；
  - `registry.tsx` 严格按 v1 Envelope 解码并校验 `artifactKind`，彻底移除 `parseOutputRecord` 与 JSON 猜测；
  - 引入 `LiveToolEventsProvider` 与 `live-tool-results` 桥接 LangGraph stream 的 tools 事件，实现流式两阶段衔接：流式阶段消费 live artifact，终态阶段消费持久化 `ToolMessage.artifact`，四态严格互斥分支渲染。
- **Markdown 改用 assistant-ui Streamdown 与代码高亮（P8 落地）**：
  - 彻底删除 `MarkdownMessage.tsx`，卸载 `react-markdown`、`remark-gfm` 与 `@assistant-ui/react-markdown`；
  - 基于 `@assistant-ui/react-streamdown` 的 `StreamdownTextPrimitive` 重构 `components/markdown-text.tsx`，保留中文字体排版与代码复制头（`CodeHeader`）；
  - 引入 `@streamdown/code` 插件提供 Shiki 语法高亮，`index.css` 声明 Tailwind v4 `@source` 编译路径。
- **Stop 与生命周期回归官方**：
  - 前端 Stop 仅调用官方 `stream.stop({ cancel: true })`，不修补 checkpoint、不维护任何本地状态机；下一条 Human 消息直接提交创建正常新 Run。
- **Tool Protocol v1 与 Tool Registry 强类型映射**：
  - 后端所有工具输出版本化 `ToolArtifactEnvelope`（`schemaVersion=1`，`kind` 分类枚举，携带数据与观测事实元数据）；前端通过 `toolRegistry` 与 `decodeToolArtifact` 集中解码并确定性渲染，杜绝散落的 JSON 解析与任意 GenUI 自由生成风险。

---

## 二、持续有效的核心决策

1. **智能体编排自主性**：
   - 主 Agent 根据用户意图、已有事实与工具 Docstring 自主判断调用，不在 Prompt 中预设固定工具链或机械排查顺序；
   - 业务策略唯一编辑源为 `system.md`，视觉策略唯一编辑源为 `vision.md`。
2. **静态 Prompt Cache 与业务时间**：
   - 业务时间与时区统一为 `Asia/Shanghai`；
   - `system.md` 保持绝对静态以最大化供应商 Prompt Cache 命中率；
   - 当前业务时间唯一通过工具 `get_current_time` 获取，模型在需要判断相对时间时自主调用。
3. **多模型协议解耦与 Structured Output**：
   - 解耦 Provider、Vendor 与 Protocol：主 Agent 保留 `protocol="responses"`（以支持多轮 tool loop 与 reasoning 原生回传）；Title、Summary、Recommendation、Vision 明确使用 `protocol="chat_completions"`；
   - 视觉复核（Qwen3.7-plus）通过 `extra_body={"enable_thinking": False}` 关闭思考，全面采用官方 `with_structured_output(VisionObservations, method="json_mode", include_raw=True)`，消除手工正则与 `json.loads` 修补；
   - 所有 `AIMessage` 纯文本读取统一使用 `BaseMessage.text`，严禁 `str(content)`；Recommendation 统一使用 `with_structured_output(RecommendationResult)`。
4. **分层错误与安全脱敏**：
   - 用户输入错误就地在消息气泡重试，主 Run 错误以 `RunFailureCard` 展示，工具错误局限在单工具卡内；
   - 业务/参数失败返回 `status="error"` 并常驻展示原因；内部异常、请求 URL、堆栈与敏感凭据只记后端日志，严禁流入 content、artifact 或前端界面。

---

## 三、临时兼容与隔离边界

1. **DeepSeek Thinking 多轮 Adapter**：
   - `langchain-deepseek==1.1.0` 尚未在多轮 tool-loop 中原生回传 `reasoning_content`；
   - 极窄请求适配器 `DeepSeekThinkingChatModel._get_request_payload()` 仅限定在主 Agent 多轮场景，一旦官方上游修复即刻删除。
2. **Site Environment 外部故障强隔离**：
   - `inspect_site_environment` 中 Open-Meteo DEM 地形与 Macrostrat 地质单元的网络/HTTP 异常在局部完全捕获并记录至 `limitations`；
   - 外部服务单点故障绝不导致主流程崩溃，站点信息及成功获取的另一方数据完整保留。

---

## 四、验证基线与质量门禁

- **后端自动化测试**：
  ```powershell
  cd backend; .\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py" -v
  ```
  常规包含 68 项单元与集成测试（66 项通过，2 项隔离 Server E2E 需环境变量 `LMA_RUN_SERVER_E2E=1` 触发）。
- **前端自动化测试与构建**：
  ```powershell
  cd frontend; pnpm run test; pnpm run build
  ```
  包含 62 项关键路径与集成回归测试，生产构建无类型与打包错误。
- **提交规范**：
  - 执行 `git diff --check` 确认无格式或空白问题；
  - 严禁提交 `.env`、密钥、真实账号或敏感数据。
