# 项目状态与有效决策

更新：2026-09-21。本文件只记录当前事实、持续有效决策和临时例外；实施计划与完成状态统一维护在 [TODO.md](TODO.md)。产品口径以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准。

## 当前架构

### 后端

- 主图 `backend/app/agent/graph.py:graph` 使用 LangChain `create_agent`，由 LangGraph Agent Server 管理 Thread、Run 与 Checkpoint。
- 长上下文、模型/工具重试、调用限额和最终工具错误转换使用官方 Middleware；`ToolErrorMiddleware` 在外层统一脱敏，`ToolRetryMiddleware` 在内层只重试瞬时异常，底层模型 SDK 不叠加重试。
- 上下文展示的实际用量只来自供应商 `usage_metadata`，窗口上限只从模型 `profile.max_input_tokens` 读取；官方 Profile 优先，自定义模型只补入缺失的最小 Profile。摘要阈值与展示用量彼此独立。
- 工具使用 Pydantic 参数与 `response_format="content_and_artifact"`；`content` 供模型判断，`artifact` 仅在成功或需要保留部分证据时供客户端展示。普通错误不伪造 artifact。
- Artifact 按 `kind` 使用严格 Pydantic 判别联合；客户端展示字段只位于 `artifact.data`，来源、限制、观测时间和错误保持 envelope 元数据。
- `system.md` 和 `vision.md` 分别是主业务与视觉策略的唯一编辑源；System Prompt 保持静态，当前业务时间通过 `get_current_time` 获取，时区统一为 `Asia/Shanghai`。
- 会话标题由 assistant-ui Adapter 的 `generateTitle()` 调用独立 `session-title` 图生成并写入 `thread.metadata.name`；主图不生成标题。
- 下一步建议当前仍在主 Run 的 `aafter_agent` 阶段生成，是否拆为独立 Run 以实测延迟为准。

### 前端

- 单向链路为 assistant-ui runtime -> `@assistant-ui/react-langchain` -> `@langchain/react useStream` -> LangGraph Server。
- Thread、Message、Composer、Reasoning、Tool Call 和 Thread List 使用 assistant-ui 官方 Primitives/Elements；LMA 只维护领域 Renderer 和必要适配。
- 会话 ID 满足 `remoteId === externalId === thread_id`，列表使用官方 `ThreadListPrimitive.LoadMore`；URL 仅承担当前会话导航，通过公共 `threads.switchToThread` / `switchToNewThread` action 支持深链接、刷新及浏览器前进后退。
- LangChain 摘要消息保持官方 converter 的 HumanMessage 角色，前端通过公开 `useLangChainState("messages")` 读取 `lc_source` metadata 并渲染折叠摘要；仓库不再维护依赖 patch。
- 已知监测工具通过 `features/monitoring/toolkit.tsx` 注册为 assistant-ui backend Toolkit renderer，只读取官方 ToolCall Part 的 `status`、`result`、`artifact`、`isError` 与 timing；未知工具才进入通用 `ToolFallback`。
- 持久化 `ToolMessage.artifact` 是工具展示的权威数据；前端不再订阅 tools channel，不维护 wire parser、工具 Registry 生命周期或 live artifact 上下文。
- 前端 artifact 使用与后端对应的 TypeScript 判别联合和 fail-closed decoder；领域 Renderer 接收具体 `data` 类型，不猜测旧字段位置。
- 上下文入口使用 assistant-ui registry 的 Context Display；通用类名合并使用官方 `cn` 包，不再维护 CircularProgress、`clsx` 或 `tailwind-merge` 直接依赖。
- 布局保持左侧 Thread List 与中央 Chat；前端继续使用 React、TypeScript、Vite、Tailwind CSS、assistant-ui、Streamdown 和 shadcn/ui。

## 持续有效决策

- Agent 根据目标、上下文、证据质量和工具描述自主编排，不在提示词中固化固定步骤或工具顺序。
- 平台事实必须来自工具；视觉候选必须数值复核；天气只作为相关证据；滑坡结论使用不确定措辞，不生成官方预警等级或撤离命令。
- 用户输入、外部资料、历史摘要、工具结果和模型输出都视为不可信数据。工具保持只读和最小权限，模型输出不得直接进入命令、URL、HTML 或其他副作用操作。
- 工具异常、缺测、抽稀、坐标或数据源缺失必须显式说明。内部异常、请求 URL、堆栈和秘密只写后端日志，不进入消息或 artifact。
- 仅明确的瞬时失败可以重试；参数、权限、业务拒绝、空数据、视觉格式错误和空观察不重试。模型与工具调用限额按每个 Run 统计逻辑调用。
- 只有已经取得可展示证据的失败才由工具显式返回 `ToolMessage(status="error", artifact=...)`；其余业务、参数、平台与内部错误统一交给官方错误生命周期，原始供应商诊断只写日志。
- Provider、Vendor 与 Protocol 解耦。主 Agent 按供应商能力选择 Responses 或 Chat Completions；标题、摘要、推荐和视觉复核独立配置思考行为。
- 所有 `AIMessage` 纯文本通过 `BaseMessage.text` 读取；结构化输出使用官方 `with_structured_output` 和严格 schema。

## 临时例外

- `_sanitize_unanswered_tool_calls` 当前在新 Run 前修复 Stop 遗留的悬空 tool-call；R7 以真实 Agent Server E2E 验证官方 cancel 后决定是否删除。
- `DeepSeekThinkingChatModel` 当前只补足 DeepSeek 多轮 tool-loop 的 `reasoning_content` 回传；上游原生支持并通过回归测试后删除。
- 场地环境外部服务故障必须局部隔离：DEM 或地质数据源单点失败不阻断其他证据，限制写入 `limitations`。

## 验证基线

- 仓库级 GitHub Actions 在 Pull Request 和 `main` 推送时分别执行后端测试/图导入，以及前端单测、构建和 Playwright 关键场景；浏览器失败时上传 7 天诊断产物。

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py" -v

cd ..\frontend
pnpm run test:gate

cd ..
git diff --check
```

- 后端 Server E2E 由 `LMA_RUN_SERVER_E2E=1` 显式启用，真实 LLM 和真实监测平台账号不进入 PR 强制门禁。
- 前端 `test:gate` 依次执行 Vitest、Playwright 关键场景和生产构建。
- 不提交 `.env`、密钥、令牌、真实账号、隐私数据或测试生成物。
