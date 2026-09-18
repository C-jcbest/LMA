# 项目状态与有效决策

更新：2026-09-18。只保留当前系统权威实现、持续有效决策、临时兼容边界与验证基线。
产品口径以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准，活跃演进待办以 [现行待办入口](TODO.md) 与 [TODO_2026-09-18.md](TODO_2026-09-18.md) 为准。

---

## 一、当前系统实现

### 1. 后端 Agent Runtime
- **主图工厂**：`backend/app/agent/graph.py:graph` 基于 LangChain 官方 `create_agent` 构建，负责 ReAct 循环与工具并行执行。
- **官方 Middleware 统一装配**：
  - `SummarizationMiddleware`：Token 驱动（默认 800k trigger / 400k keep）长上下文管理，保留官方 nostream 标签与安全切点；
  - `ModelRetryMiddleware` / `ToolRetryMiddleware`：仅针对网络超时/中断及 408/429/5xx 瞬时异常退避重试，底层 SDK 禁用重试；
  - `ModelCallLimitMiddleware`（默认 20 次）/ `ToolCallLimitMiddleware`（默认 40 次）：逻辑调用限额控制；
  - `ToolErrorMiddleware`：统一捕获非受控异常并转换为安全脱敏错误文案，放行领域异常。
- **LMA 领域扩展极简化**：
  - `LmaMiddleware` 仅承担业务时间锚点装配、`context_usage` 统计展示、回答完成后单次推荐触发，以及领域异常（`ToolFailure`）的安全展示 envelope；
  - 彻底删除通用异常兜底与多余的重试/调度逻辑。
- **服务端 Stop 自愈**：
  - 注册 `abefore_agent` 钩子 `_sanitize_unanswered_tool_calls`；
  - 在当前 Run 启动前扫描 checkpoint 中的消息，利用官方 `RemoveMessage` 清除全未完成的悬空 AI tool-call 消息，原位收窄部分完成批次，确保模型节点绝不接收未配对的 tool-calls。

### 2. 前端架构与交互 (Frontend V2，2026-09-19)
- **assistant-ui 与 LangGraph Runtime 深度集成**：
  - 核心采用 `@assistant-ui/react` 与 `@assistant-ui/react-langchain` 的 `useStreamRuntime`；
  - 彻底移除前端私有状态机与第二套权威历史，LangGraph Checkpoint/Thread 仍为唯一事实来源；
  - URL 为会话唯一标识入口（`/chat`、`/chat/:threadId` 由 `react-router-dom` v7 驱动）。
- **专业领域监测 Tool 体系**：
  - 统一通用外壳 `ToolFallback`：中文动作摘要、默认折叠、展开切换、运行态 Spinner、受控错误提示；
  - 集中解码 `toolResultAdapter.ts` 与分发 `toolkit.tsx`，连接 GNSS 位移图表、天气预报、测点在网状态、现场视觉核查（点击全屏 Dialog 放大）与站点地质地形空间图层；
  - 保持“工具返回即完成”，空结果正常展示“该步骤没有可展示的业务数据”，绝不回退为 loading。
- **现代会话资源管理 (TanStack Query 5)**：
  - 历史会话列表由 `useInfiniteQuery` 进行分页与搜索管理，独立于当前流式消息；
  - 重命名与删除使用 `useMutation` 并通过 `sonner` 全局通知，结合 Radix `Dialog` 与 `AlertDialog`。
- **极简专业设计规范 (Tailwind CSS 4)**：
  - 升级至 Tailwind 4（`@theme` semantic tokens），浅灰极简监测视觉风格；
  - 思考过程（Reasoning）默认折叠并支持点击展开批注；长表格横向滚动；支持 HITL 人机交互中断确认。

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
  包含 68 项单元与集成测试（66 项通过，2 项隔离 Server E2E 需环境变量 `LMA_RUN_SERVER_E2E=1` 触发）。
- **前端自动化测试与构建**：
  ```powershell
  cd frontend; pnpm run test; pnpm run build
  ```
  包含 88 项单元与组件测试（全数通过），生产构建无类型与打包错误（`tsc && vite build` ~689ms）。
- **提交规范**：
  - 执行 `git diff --check` 确认无格式或空白问题；
  - 严禁提交 `.env`、密钥、真实账号或敏感数据。
