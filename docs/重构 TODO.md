# LMA 全栈“官方优先”重构审计与执行计划

> 审计日期：2026-09-21  
> 目标分支：`feat/frontend-refactor`  
> 审计基线：`0b06cedffdab10b454b3f2ff1352377726f63cf4`  
> 原则：**不兼容旧架构；允许删除/重写通用基础设施；保留 LMA 核心监测业务能力与当前“左侧会话栏 + 中央聊天区”的基本视觉风格。**
>
> 本文是本分支后续重构的唯一主 TODO。旧版 2026-09-19 TODO 中与当前代码不一致的“已完成”状态，以本文为准。

---

## 0. 最终目标

最终代码只自行维护两类内容：

1. **LMA 领域能力**：北斗/GNSS 数据、站点与分组、天气、视觉复核、场地环境、业务时间、监测结果展示和领域提示词。
2. **必要的产品胶水**：API 地址、URL 中的 threadId、LMA 业务 Tool UI 映射、少量品牌/视觉样式。

以下通用能力必须优先交给官方框架，不再自行维护第二套实现：

- Agent ReAct 循环、工具执行、工具重试、工具错误转换、调用次数限制、摘要压缩：LangChain / LangGraph。
- Thread / Run / Checkpoint / Streaming / Persistence：LangGraph Agent Server + 官方 SDK。
- React 流式运行时：`@assistant-ui/react-langchain` + `@langchain/react/useStream`。
- Thread / Message / Composer / Reasoning / Tool 生命周期 / Approval / Suggestion：assistant-ui。
- Button / Dialog / Tooltip / Collapsible / Sonner 等通用 UI：shadcn/ui。
- 上下文用量展示：assistant-ui Context Display Element。
- 组件安装/更新：assistant-ui / shadcn 官方 CLI；不要手工复制一套“近似官方组件”。

目标不是“所有文件都来自第三方”，而是**通用机制由官方维护，LMA 只维护业务差异**。

---

## 1. 审计结论

### 1.1 已经符合官方推荐方向，继续保留

| 区域 | 当前实现 | 结论 |
|---|---|---|
| Agent 主循环 | `langchain.agents.create_agent` | ✅ 保留。不要退回手写 StateGraph ReAct 循环。 |
| Agent 通用能力 | `SummarizationMiddleware`、`ModelRetryMiddleware`、`ToolRetryMiddleware`、`ToolErrorMiddleware`、调用上限 middleware | ✅ 方向正确，但工具 middleware 顺序与自定义 wrapper 需要收敛，见 B-01/B-02。 |
| 工具定义 | LangChain `@tool` + Pydantic args schema | ✅ 保留。 |
| 工具双通道结果 | `response_format="content_and_artifact"` | ✅ LangChain 官方能力，可继续用于“模型事实 + UI 展示载荷”分离；不要自行发明第二套 transport。 |
| 模型初始化 | `init_chat_model` 为主 | ✅ 保留。Provider 特例必须限制在极小 adapter 内。 |
| Agent Server | `langgraph.json` + graph factory | ✅ 官方部署结构。 |
| 本地/生产服务 | `langgraph dev` / `langgraph build` | ✅ 保留；不需要为了“全栈”再套一层 FastAPI 转发 Agent。 |
| 前端运行时 | `useStreamRuntime` from `@assistant-ui/react-langchain` | ✅ 当前最合适。官方文档明确把它作为已有 `@langchain/react` 项目的轻量路径。 |
| Thread 持久化 | `RemoteThreadListAdapter` + LangGraph Thread SDK | ✅ 这是官方扩展缝，不算重复造轮子。 |
| UI 基础 | assistant-ui Elements + shadcn/ui | ✅ 方向正确；允许在 Elements 生成源码上改 className 保持 LMA 风格。 |
| Markdown | Streamdown / assistant-ui Streamdown element | ✅ 保留。 |
| 部署持久化 | Agent Server + PostgreSQL + Redis | ✅ 当前 compose 方向与 Agent Server 架构一致。 |

### 1.2 当前没有完全收敛到“官方优先”

最重要的问题不是业务组件，而是仍存在一层自定义“运行时补丁 + Tool 流解析 + 状态再合并”。

优先级定义：

- **P0**：会继续制造运行时分叉、升级风险或状态不一致，先改。
- **P1**：官方已有现成组件/能力，当前仍手写，第二批改。
- **P2**：不是错误，但能继续显著删代码/依赖，最后收敛。

---

# 2. P0：先消灭运行时分叉

## F-01：不要长期维护 `@assistant-ui/react-langchain` 的 pnpm patch

### 当前证据

- `frontend/package.json` 使用：
  - `pnpm.patchedDependencies["@assistant-ui/react-langchain@0.0.32"]`
- `frontend/patches/@assistant-ui__react-langchain@0.0.32.patch` 修改官方包：
  1. 将 `additional_kwargs.lc_source === "summarization"` 的 human message 改映射为 system；
  2. 给 `useStreamRuntime` 补 `threadId / initialThreadId` 受控透传。
- `AssistantProvider.tsx` 因此可以直接传入 `threadId: urlThreadId`。

### 判断

这是**当前最大的升级耦合点**，但不能简单写成“升级依赖即可删除”。

截至本次审计的 assistant-ui 主仓库，`@assistant-ui/react-langchain` 仍为 `0.0.32`，公开源码已经有 `onThreadIdChange`，但顶层 `useStreamRuntime` 尚未公开透传受控 `threadId`；summary 的 `lc_source=summarization` 也没有官方转换逻辑。因此该 patch 目前确实在弥补真实的上游互操作缺口。

### 迁移方案

**F-01A：先删除 threadId patch 部分。**

不要继续修改第三方 Runtime。改成：

- `useStreamRuntime(...)` 只使用官方公开 options。
- 保留 `onThreadIdChange`：Runtime -> URL。
- 新增一个非常薄的 `UrlThreadSync`，放在 `AssistantRuntimeProvider` 内：
  - URL 有 `threadId`：通过 assistant-ui 公共 Thread List runtime/action 切换到该 thread。
  - URL 无 `threadId`：切换 New Thread。
  - `popstate` 同样走公开 thread switch action。
- 不直接操作消息数组、不自己 hydrate、不自己恢复 stream。

目标：URL 同步只是“路由胶水”，不是 Runtime fork。

**F-01B：summary patch 单独隔离，不再扩展。**

官方 `SummarizationMiddleware` 会在历史中放置内部 summary 消息，而当前 react-langchain converter 未识别 `lc_source=summarization`。在上游正式支持前：

- 保留该 patch 的最小 summary 映射部分；
- 在本文标记为 **UPSTREAM BLOCKED**；
- 不在 patch 中加入任何 LMA 业务逻辑；
- assistant-ui 新版本发布时先检查 upstream converter，再删除 patch。

若后续决定不在聊天 UI 中展示“对话已压缩”提示，则可以评估完全隐藏内部 summary 的官方方案；在没有官方 seam 前，不再自建第二套 message converter。

### 验收

- 直接打开 `/?threadId=<existing>` 能恢复历史。
- 浏览器前进/后退正确切换。
- 切会话再回来，正在运行的流仍由 `useStream` 恢复/显示。
- package patch 只剩 summary workaround；最终上游支持后 `patches/` 整目录删除。

### 官方依据

- https://www.assistant-ui.com/docs/runtimes/langchain
- https://www.assistant-ui.com/docs/guides/context-api
- https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-langchain

---

## F-02：删除 `live-tool-results.ts`，禁止解析 `tools` channel 私有 wire envelope

### 当前证据

`frontend/src/lib/langgraph/live-tool-results.ts`：

- 直接调用 `@langchain/react/useChannel(stream, ["tools"])`；
- 识别 `tool-finished`；
- 手工兼容 `value[field] / value.kwargs[field] / value.lc_kwargs[field]`；
- 再从 `ToolMessage` wire data 中抽取 `artifact`。

`tool-fallback.aui.tsx` 又把：

1. assistant-ui MessagePart status；
2. `useLangChainToolCalls()`；
3. 自定义 tools channel live artifact；
4. 持久化 artifact；

合并成自己的“最终状态”。

### 判断

这是典型的重复运行时层。它依赖 wire shape，且 assistant-ui / @langchain/react 升级后容易失效。

官方已经提供两条稳定路径：

1. `useLangChainToolCalls()`：读取 root tool call 的实时状态；
2. LangGraph Data UI：后端 `push_ui_message()` + 前端 `makeAssistantDataUI()`，同时覆盖 live custom channel 与 state snapshot。

### 迁移方案

- 删除 `frontend/src/lib/langgraph/live-tool-results.ts`。
- `AssistantProvider` 删除 `LiveToolEventsProvider`。
- 工具“运行中/完成/失败”状态只读 assistant-ui ToolCall part / toolkit render 的 `status`。
- 工具最终普通 JSON 结果：使用官方 Tool UI 的 `result`。
- 需要与模型 content 分离的富展示数据、图片、较大展示 payload：改成 LangGraph Data UI：
  - Agent state 增加官方 `ui` reducer；
  - 在业务工具完成后由后端按官方方式 `push_ui_message(name, data, ...)`；
  - 前端用 `makeAssistantDataUI` 注册 LMA 业务组件。
- state snapshot 必须能在刷新后恢复；live custom event 只负责“更早显示”，不能成为唯一事实源。

### 验收

- 同一批并行工具谁先返回，谁先进入 complete 并显示自己的结果，不等待整批完成。
- 空结果仍显示“完成”，而不是永久 running。
- 刷新后已完成工具结果仍存在。
- 前端不再出现 `tool-finished`、`lc_kwargs`、`useChannel(["tools"])` 等 wire-level 解析代码。

### 官方依据

- https://www.assistant-ui.com/docs/runtimes/langchain
- https://www.assistant-ui.com/docs/tools/tool-ui
- https://www.assistant-ui.com/docs/api-reference/tools/rendering
- https://docs.langchain.com/langsmith/generative-ui-react

---

## F-03：已知 LMA 工具改用 assistant-ui Toolkit 注册，不再让一个 24KB Fallback 承担业务渲染

### 当前证据

`tool-fallback.aui.tsx` 同时实现：

- 官方 fallback 外观；
- 审批交互；
- 工具 duration；
- LMA 工具中文文案；
- LMA Tool registry；
- live tool status 修正；
- persisted/live artifact 合并；
- error envelope -> assistant-ui status 再映射；
- 业务组件选择。

### 判断

Fallback 应只处理“没有专用 renderer 的未知工具”。LMA 已知工具应该使用 assistant-ui 当前推荐的 **Toolkit** API。

官方已经把旧的 `makeAssistantToolUI/useAssistantToolUI` 标为 deprecated，推荐 `defineToolkit + Tools({ toolkit })`；外部后端执行的 LangGraph tool 可以注册 render-only backend tool。

### 迁移方案

新建例如：

`frontend/src/features/monitoring/toolkit.tsx`

使用官方 plain toolkit（Vite 项目不必为了这一步引入额外 compiler）：

- key 与 LangGraph tool name 完全一致；
- `type: "backend"`；
- 每个条目只放 `render({ args, result, status, ... })` / `renderText`；
- 不在前端重新声明执行函数。

在 `AssistantRuntimeProvider` 注册：

- `AuiConfig({ tools: Tools({ toolkit }) })`

然后：

- 已知 LMA 工具由 toolkit renderer 展示；
- `ToolFallback` 恢复为 assistant-ui Element 的通用 fallback，最多保留 LMA 视觉 className；
- 删除 `getEffectiveStatus`；
- 删除 live/persisted artifact 两阶段状态逻辑；
- 删除 Fallback 内的 LMA registry 分支。
- Approval 只有确实需要 HITL 时才保留官方 Tool UI / interrupt 机制；当前普通查询工具不要人为制造 requires-action。

### 验收

- `tool-fallback.aui.tsx` 不再 import `@langchain/react`。
- `tool-fallback.aui.tsx` 不再 import LMA `registry`。
- 每个 LMA 工具 renderer 可单独测试。
- 未注册的新工具仍能由官方 fallback 正常显示。
- UI 风格保持当前轻量文本/卡片风格，不恢复二级“监测操作”折叠层。

### 官方依据

- https://www.assistant-ui.com/docs/tools/defining-tools
- https://www.assistant-ui.com/docs/migrations/toolkit-tools
- https://www.assistant-ui.com/docs/api-reference/tools

---

## B-01：修正 ToolRetry / ToolError 官方 middleware 顺序

### 当前证据

`backend/app/agent/graph.py` 当前顺序：

`... ModelRetryMiddleware -> ToolErrorMiddleware -> ToolRetryMiddleware`

LangChain 官方文档明确要求组合时：

`ToolRetryMiddleware(... on_failure="error"), ToolErrorMiddleware(...)`

即重试层先处理瞬时失败，耗尽后再交给错误转换层生成安全 ToolMessage。

### 迁移方案

改成：

`... ModelRetryMiddleware -> ToolRetryMiddleware -> ToolErrorMiddleware`

同时保证：

- transient 错误由 ToolRetry 负责；
- 重试耗尽才进入 ToolError；
- ToolError 只负责“转换成可给模型看的安全错误”，不做第二次 retry。

### 验收

新增/保留测试：

1. transient Beidou/API 失败 N 次后成功：只执行预期次数；
2. non-retryable 参数/业务失败：不重试；
3. retry exhausted：只生成一个最终 error ToolMessage；
4. 原始内部异常文本不泄露到模型/UI。

### 官方依据

- https://docs.langchain.com/oss/python/langchain/middleware/built-in

---

## B-02：删除 `LmaMiddleware.awrap_tool_call` 的第二套 Tool 错误状态机

### 当前证据

当前同时存在：

- `ToolRetryMiddleware`
- `ToolErrorMiddleware`
- `LmaMiddleware.awrap_tool_call`
- `ToolFailure`
- `BeidouApiError` 手工转 `ToolMessage(status="error")`
- 对 validation/error ToolMessage 再补 artifact envelope

### 判断

业务异常分类可以保留，但**执行/重试/错误状态转换应只由官方 middleware 链负责**。

### 迁移方案

- `_on_tool_error` 统一处理：
  - `ToolFailure` -> 审定后的业务提示；
  - `BeidouApiError` -> 监测平台受控提示；
  - transient exhausted -> 服务暂不可用；
  - 其余 -> 通用内部错误。
- `ToolRetryMiddleware.retry_on` 决定哪些异常可重试。
- 删除 `LmaMiddleware.awrap_tool_call` 中对成功/失败 ToolMessage 的生命周期修复。
- Tool 的展示 error UI 读取 assistant-ui 官方 `status/result`；不要要求每个失败都再构造一份 artifact 才能显示。
- `ToolFailure` 最终尽量收敛成一个非常薄的公开业务异常类；若 category 只用于前端着色且没有产品价值，删除 category/envelope。

### 验收

`LmaMiddleware` 不再手工 new `ToolMessage`。

---

## B-03：删除服务端 `_sanitize_unanswered_tool_calls`，让取消语义只有一个负责人

### 当前证据

`graph.py` 在每次 run 前会扫描完整历史并：

- 改写 AIMessage.tool_calls；
- 清空 tool_calls；
- 或发 `RemoveMessage`。

而当前前端使用的 react-langchain Runtime 本身已经处理 pending tool calls / cancel / stop；项目只服务该官方 Runtime，不需要再在服务端猜测“历史中的 tool call 为什么没回答”。

### 风险

直接改写旧 checkpoint 的 AIMessage 结构，可能：

- 改掉真实历史；
- 破坏 checkpoint/time-travel 语义；
- 与客户端自动 cancel 产生两套补偿逻辑。

### 迁移方案

先补 E2E，再删除：

1. 启动包含并行工具的 run；
2. 工具执行中点击 Stop；
3. 刷新；
4. 再发送新消息；
5. 切换 thread 再回来。

若官方 runtime 能正确生成/恢复取消 ToolMessage，则删除：

- `_sanitize_unanswered_tool_calls`
- `abefore_agent` 中对应修复

若确有上游 bug，先记录最小复现并只保留一处 workaround，不再“通用扫描 + 猜测”。

---

# 3. P1：已有官方组件，停止手写

## F-04：用 assistant-ui Context Display 替换手写上下文圆环

### 当前证据

旧 TODO 写“上下文展示已使用官方 Context Element”，但实际：

`frontend/src/components/assistant-ui/elements/context-usage.aui.tsx`

仍手写：

- `CircularProgress`
- 颜色阈值
- button
- tooltip
- token formatter
- hover/focus 动画

assistant-ui 已提供官方 Context Display Element，支持 ring/bar/text、hover details，而且有 props-driven standalone 用法。

### 迁移方案

使用官方 CLI：

`pnpm dlx shadcn@latest add "@assistant-ui/context-display"`

然后：

- 删除 `context-usage.aui.tsx` 中自绘 UI；
- 删除 `circular-progress.tsx`（若无其他用途）；
- 用 standalone props 适配 LMA 的 LangChain usage；
- 只保留必要 className 尺寸覆盖以维持现有小圆环风格。

### 验收

- UI 仍是 16~20px 轻量环形入口；
- hover/focus 可访问；
- 组件来自 assistant-ui registry；
- 项目不再维护自绘 SVG/tooltip。

### 官方依据

- https://www.assistant-ui.com/elements/context-display

---

## B-04：上下文窗口大小优先使用 LangChain Model Profile，删除展示用的第二套 token 估算体系

### 当前证据

当前同时维护：

- `CONTEXT_MODEL_CONTEXT`
- `CONTEXT_OUTPUT_RESERVE_TOKENS`
- `CONTEXT_SAFETY_MARGIN_TOKENS`
- `CONTEXT_TOKEN_ESTIMATE_FACTOR`
- `CONTEXT_CHARS_PER_TOKEN`
- `count_tokens_approximately`
- provider 实际 `usage_metadata.input_tokens`

但最终 UI 的“本轮输入量”已经使用 provider reported usage。

LangChain Model Profile 已有：

- `max_input_tokens`
- `tool_calling`
- `reasoning_output`

官方 `SummarizationMiddleware` 还可以直接按 model profile 的 context fraction 触发。

### 迁移方案

1. 模型有官方 profile：
   - 直接读 `model.profile["max_input_tokens"]`。
2. 自定义 endpoint / 自定义模型名没有 profile：
   - 在 `init_chat_model(..., profile={...})` 显式补最小 profile，而不是在 context.py 再维护一套“模型上下文配置”。
3. `context_usage` 只保留展示真正需要的字段：
   - input tokens
   - output tokens
   - max input tokens
   - ratio
4. 删除 `build_context_budget` 的 fixed/history 近似拆分与误差字段，除非它进入论文实验指标。
5. 摘要配置继续使用官方 `SummarizationMiddleware`；后续可由绝对 token threshold 简化为 profile fraction + 官方 keep 语义。

### 不要做

- 不自己实现 tokenizer。
- 不用前端字符串长度猜上下文。
- 不让 UI 展示估算值冒充 provider usage。

### 官方依据

- https://docs.langchain.com/oss/python/langchain/models
- https://docs.langchain.com/oss/python/langchain/middleware/built-in

---

## B-05：OpenAI reasoning 参数使用 LangChain 标准参数，Provider adapter 只留下真正无法统一的差异

### 当前证据

`models.py` 已经正确以 `init_chat_model` 为主，但仍有 `thinking_options()` 对 OpenAI/DashScope/DeepSeek 手工分支。

LangChain 当前已将 `reasoning_effort` 定义为跨 Provider 标准参数；OpenAI integration 版本也已满足其版本要求。

### 迁移方案

- OpenAI 官方模型：
  - 优先 `init_chat_model(..., reasoning_effort=...)` / 官方 integration 参数；
  - 不再手工拼 OpenAI reasoning body。
- DeepSeek：
  - 保留当前极窄 `DeepSeekThinkingChatModel`，因为它是在补 reasoning_content 多轮 tool calling 的上游缺口；
  - 单独写测试，官方修复后直接删除 subclass。
- DashScope OpenAI-compatible endpoint：
  - 只有项目确实使用时才保留 vendor mapping；
  - 如果不是当前部署需求，删除“为了未来也许会用”的兼容代码。
- 不通过模型名猜 provider；这一点当前实现是正确的，继续保留。

### 验收

`models.py` 的自定义代码只描述“官方 integration 当前缺少的能力”，不重复标准参数转换。

---

## F-05：用 shadcn CLI 管理基础组件和依赖，清理重复 Radix 依赖

### 当前证据

`components.json` 已正确配置 `@assistant-ui` registry，且项目是 Tailwind 4 + React 19。

但 `package.json` 同时有：

- `radix-ui`
- 多个 `@radix-ui/react-*`
- `cn`
- `clsx`
- `tailwind-merge`

当前部分新组件已经从 `radix-ui` 和 `cn` 导入，说明依赖集很可能混有重构前遗留。

### 迁移方案

不要手工猜依赖，按 CLI + 使用检查执行：

1. `pnpm dlx shadcn@latest --help`
2. 对需要更新的组件先 `--dry-run` / `--diff`。
3. 只重新拉取通用 shadcn/assistant-ui 元素；LMA 业务 renderer 不覆盖。
4. `pnpm why <package>` 确认后删除未使用的 scoped Radix 包、旧 cn 组合依赖或其他残留。
5. 每批删除后 `pnpm build && pnpm test`。

### 注意

shadcn 组件本质是“源码分发”，项目内有组件源码是正常的；目标不是把所有组件变成 node_modules 黑盒，而是**用官方 registry/CLI 作为来源并减少手工基础设施**。

### 官方依据

- https://ui.shadcn.com/docs/cli
- https://ui.shadcn.com/docs/installation/vite
- https://ui.shadcn.com/docs/tailwind-v4

---

# 4. P2：进一步删代码，但不属于框架错误

## F-06：会话标题图可删除，除非确认 LLM 标题确有产品价值

### 当前实现

为了自动标题，目前存在：

- `session-title` 第二个 LangGraph graph；
- `backend/app/agent/title.py`；
- 前端 `generateSessionTitle()`；
- `thread-list-adapter.generateTitle()`；
- 直接依赖 `assistant-stream`。

`RemoteThreadListAdapter.generateTitle` 本身属于官方 seam，所以当前实现不是“错误”。

### 简化建议

LMA 核心业务不依赖 AI 标题。若目标优先减少维护：

- 删除 `session-title` graph；
- 删除标题 LLM 调用；
- thread 初始标题直接取首条用户消息的安全截断/首行；
- 或保持“新会话”，用户手动 rename。

这样可减少一个部署 graph、一类模型配置、一条网络调用和一个前端 stream 依赖。

如果保留 AI 标题，也不要自行增加更多 fallback 状态机。

---

## B-06：推荐问题生成可保留，但不要继续扩张成第二个 Agent

`aafter_agent -> generate_recommendations` 是明确产品功能，不属于重复造轮子。

后续只做两点：

- 保持为一次结构化 LLM 调用，不引入独立 planner/graph。
- 如果它明显拖长“主 Run 已回答但仍显示运行中”的时间，再把它拆成单独可取消的后处理 run；在没有实际 UX 问题前不要预先复杂化。

---

## D-01：补 CI，防止“官方化”重构以后再次倒退

当前分支未发现仓库级 GitHub Actions workflow。

新增一个最小 `.github/workflows/ci.yml`，只做稳定门禁：

### Backend

- 安装 `backend/requirements.txt` + dev requirements
- `pytest`
- 导入 graph / 配置 smoke test
- `langgraph build` smoke（若 CI 环境允许 Docker；否则至少在 release workflow 执行）

### Frontend

- `pnpm install --frozen-lockfile`
- `pnpm test`
- `pnpm build`
- 关键 Playwright E2E

### 架构防回归 grep

可增加小型脚本检查：

- 不允许重新出现 `useExternalStoreRuntime` 自建聊天 runtime；
- 不允许新增 `useChannel(["tools"])` wire parser；
- 不允许新增第三方包 patch（除已登记 upstream blocker）；
- 不允许新建第二套 Tool status enum；
- 不允许业务代码直接 fetch LangGraph REST（应使用 SDK）。

---

# 5. 目标架构

```text
Browser
  └─ AssistantRuntimeProvider
       ├─ @assistant-ui/react-langchain useStreamRuntime
       │    └─ @langchain/react useStream
       │         └─ @langchain/langgraph-sdk Client
       │              └─ LangGraph Agent Server
       │
       ├─ assistant-ui Thread / Message / Composer / Reasoning / Tool status
       ├─ assistant-ui Toolkit
       │    └─ LMA render-only backend tool UI
       ├─ assistant-ui Data UI
       │    └─ GNSS / weather / vision / site rich result
       └─ assistant-ui Context Display + shadcn/ui

LangGraph Agent Server
  └─ lma-agent
       ├─ create_agent
       ├─ LMA system prompt
       ├─ official middleware
       │    ├─ SummarizationMiddleware
       │    ├─ ModelCallLimitMiddleware
       │    ├─ ToolCallLimitMiddleware
       │    ├─ ModelRetryMiddleware
       │    ├─ ToolRetryMiddleware
       │    └─ ToolErrorMiddleware
       ├─ LMA domain tools
       └─ minimal LMA middleware
            ├─ domain-only UI/data emission if needed
            ├─ context usage projection
            └─ optional follow-up suggestions

Persistence
  ├─ LangGraph Threads / Runs / Checkpoints
  ├─ PostgreSQL
  └─ Redis (Agent Server runtime infrastructure)
```

禁止重新引入：

```text
自定义 SSE/WS 协议
自定义前端 run 状态机
自定义 tool-finished wire parser
自定义 Message accumulator
自定义 Thread store
自定义 ReAct 图
FastAPI 转发 LangGraph stream
第二套 tool retry/error engine
通用 UI 的手写 Dialog/Tooltip/Progress
```

---

# 6. 可执行迁移顺序

## R0 — 固化基线测试

先不改架构，补/确认以下回归：

- 普通文本问答。
- 单工具调用。
- 同轮 2~3 个并行工具，返回顺序不同。
- 空工具结果。
- 参数错误。
- API transient -> retry -> success。
- API retry exhausted。
- Stop 正在执行的工具。
- Stop 后继续发消息。
- 切会话再回来恢复 stream。
- 刷新恢复历史。
- 直接 URL threadId。
- 历史 summary 后继续对话。
- GNSS 大数据结果。
- 视觉图像结果。
- 下一步建议。

完成标准：当前行为先被测试固定，后续每阶段只改实现不改业务语义。

---

## R1 — Tool middleware 收敛（后端，最先改）

修改：

- `backend/app/agent/graph.py`

步骤：

1. 调整为 `ToolRetryMiddleware -> ToolErrorMiddleware`。
2. 将 ToolFailure / BeidouApiError 映射迁到 `_on_tool_error`。
3. 删除 `LmaMiddleware.awrap_tool_call` 中的 ToolMessage 构造/修复。
4. 跑 backend tests。
5. 记录 Tool retry 次数和最终消息是否与预期一致。

预期删代码：约 40~80 行。

---

## R2 — Tool UI 官方化（前端 + 少量后端）

修改/新增：

- 新建 `frontend/src/features/monitoring/toolkit.tsx`
- 简化 `frontend/src/components/assistant-ui/elements/tool-fallback.aui.tsx`
- 删除 `frontend/src/lib/langgraph/live-tool-results.ts`
- 简化 `AssistantProvider.tsx`
- 如需富展示持久化：Agent state 增加官方 `ui`，使用 `push_ui_message`

步骤：

1. 先把一个最简单工具（例如 current time/station list）迁到 toolkit。
2. 验证 `result/status` 的 live 行为。
3. GNSS/weather 迁移。
4. vision/image 使用 Data UI，验证刷新持久化。
5. 全部成功后删除 LiveToolEventsProvider。
6. Fallback 只负责未知工具。

预期收益：这是前端最大的复杂度削减点。

---

## R3 — Context Display + Model Profile

修改：

- `context-usage.aui.tsx`
- `context.py`
- `models.py`
- `config.py`

步骤：

1. CLI 安装官方 Context Display。
2. 从模型 profile 取得 max input token；缺失时显式注入最小 profile。
3. 使用 provider usage metadata。
4. 删除 fixed/history 估算字段与手写进度环。
5. 再决定摘要 trigger 是否切为 profile fraction。

预期删除：

- `CircularProgress`（若无其他引用）
- 大部分 `context.py`
- 多个 context-only env 配置。

---

## R4 — 去掉 Runtime patch 中的 threadId 修改

修改：

- `AssistantProvider.tsx`
- 新增或内联 `UrlThreadSync`
- 收窄 patch

步骤：

1. 使用 assistant-ui 公共 thread switch API 完成 URL -> runtime。
2. 保留 `onThreadIdChange` 完成 runtime -> URL。
3. 删除 patch 中 threadId/initialThreadId 修改。
4. 跑 URL/切换/流恢复 E2E。

summary patch 暂时独立保留并标记 upstream blocker。

---

## R5 — 依赖与生成组件清理

执行：

- shadcn `--dry-run` / `--diff`
- `pnpm why`
- 删除没有引用的 Radix scoped packages、旧工具依赖。
- 若 R6 删除 title graph，再删除 `assistant-stream` 直接依赖（前提是无其他直接 import）。

不要一次做“全包升级 + 架构重写”，每批依赖清理必须有 build/test。

---

## R6 — 可选极简化

按价值决定：

1. 删除 AI session title graph。
2. 删除非当前部署使用的 Vendor 兼容分支。
3. 删除不再使用的 legacy docs/tests/components。
4. summary upstream 修复发布后删除最后一个 pnpm patch。

---

# 7. 文件级“保留 / 重写 / 删除”清单

## 保留

- `backend/app/beidou/**`
- `backend/app/agent/tools.py`
- `backend/app/agent/weather.py`
- `backend/app/agent/vision.py`
- `backend/app/agent/site.py`
- `backend/app/agent/prompting.py`
- `backend/langgraph.json`（R6 若删除 title graph 则只留 lma-agent）
- `frontend/src/features/monitoring/**` 中纯业务 renderer
- assistant-ui Elements / shadcn 组件的官方生成源码 + LMA className 风格覆盖
- `RemoteThreadListAdapter`

## 重写/显著简化

- `backend/app/agent/graph.py`
- `backend/app/agent/context.py`
- `backend/app/agent/models.py`
- `backend/app/agent/tool_protocol.py`
- `frontend/src/app/providers/AssistantProvider.tsx`
- `frontend/src/components/assistant-ui/elements/tool-fallback.aui.tsx`
- `frontend/src/components/assistant-ui/elements/context-usage.aui.tsx`
- `frontend/src/features/monitoring/tools/registry.tsx` -> Toolkit/Data UI 注册

## 计划删除

确定 R2 完成后：

- `frontend/src/lib/langgraph/live-tool-results.ts`

确定 R3 完成后（无其他引用）：

- `frontend/src/components/ui/circular-progress.tsx`

确定 R6 采用“无 AI 标题”后：

- `backend/app/agent/title.py`
- `langgraph.json` 的 `session-title`
- `frontend/src/services/api.ts` 的 `generateSessionTitle`
- thread adapter 中 LLM `generateTitle`
- `assistant-stream` 直接依赖（若无其他 import）

上游 summary converter 修复后：

- `frontend/patches/@assistant-ui__react-langchain@0.0.32.patch`
- `package.json.pnpm.patchedDependencies`

---

# 8. 最终验收标准

只有同时满足以下条件，才算“官方优先重构完成”：

### 架构

- [ ] 主 Agent 是 `create_agent`，无手写 ReAct loop。
- [ ] Tool retry/error/call limit 只由 LangChain middleware 管理。
- [ ] 无服务端历史 tool-call 猜测修复器。
- [ ] 前端只有一个 assistant Runtime。
- [ ] 无自定义 SSE/WebSocket/run reducer。
- [ ] 无 `tools` channel wire envelope parser。
- [ ] 已知工具用 assistant-ui Toolkit / Data UI；Fallback 不承载业务状态机。
- [ ] Thread 仍由 LangGraph Server 持久化。
- [ ] URL threadId 只是一层路由同步，不是第二个 thread store。

### UI

- [ ] 保持当前左侧会话 + 中央聊天布局。
- [ ] 工具与 Reasoning 同层显示，不增加“监测操作”二级容器。
- [ ] 工具结果默认不展开大块原始 JSON。
- [ ] Station/异常/观察等业务组件保持轻量风格。
- [ ] Context ring 使用 assistant-ui Context Display。
- [ ] Dialog/Tooltip/Collapsible 等来自 shadcn/ui。
- [ ] Thinking 展开/折叠不导致页面抖动。

### 流式与可靠性

- [ ] 同批工具按各自返回时间完成。
- [ ] 空结果也进入 complete。
- [ ] Stop 能停止当前 run。
- [ ] Stop 后继续对话不产生 tool-call protocol error。
- [ ] 切会话后回来仍能看到当前 run。
- [ ] 刷新后历史 Tool UI 与富结果能恢复。
- [ ] Summary 后继续对话正常。
- [ ] retry 不重复产生副作用或重复 ToolMessage。

### 依赖与维护

- [ ] `pnpm patch` 最终为 0；若 summary 上游尚未修复，只允许存在本文登记的单一 blocker。
- [ ] 无重复 Radix 依赖。
- [ ] 无未使用的 `zustand/@assistant-ui/core/assistant-stream` 等直接依赖（以实际 import / `pnpm why` 为准，不凭猜测删除）。
- [ ] 通用组件通过 shadcn/assistant-ui CLI 管理。
- [ ] CI 覆盖 backend test、frontend test/build、关键 E2E。

---

# 9. 后续开发规则

新增任何“基础设施代码”前按以下顺序检查：

```text
1. LangChain / LangGraph 是否已有官方 API / middleware / SDK？
2. assistant-ui 是否已有 Runtime / Primitive / Toolkit / Element？
3. shadcn/ui 是否已有对应组件？
4. 官方 CLI / registry 是否可以直接安装？
5. 只有前四项都不满足，才新增自定义实现。
6. 若是上游缺口，必须在本文登记：
   - 上游缺什么
   - 当前 workaround 文件
   - 删除条件
   - 对应测试
```

禁止以“先兼容旧实现”为理由长期保留双轨代码。本项目已经允许破坏式重构，应直接迁到目标架构。

---

# 10. 本次审计使用的官方资料

### assistant-ui

- LangChain React Runtime  
  https://www.assistant-ui.com/docs/runtimes/langchain
- Tool UI  
  https://www.assistant-ui.com/docs/tools/tool-ui
- Toolkits / external backend tools  
  https://www.assistant-ui.com/docs/tools/defining-tools
- Toolkit migration  
  https://www.assistant-ui.com/docs/migrations/toolkit-tools
- Tool rendering API  
  https://www.assistant-ui.com/docs/api-reference/tools/rendering
- Context Display Element  
  https://www.assistant-ui.com/elements/context-display
- Assistant Context API  
  https://www.assistant-ui.com/docs/guides/context-api
- Upstream source  
  https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-langchain

### LangChain / LangGraph / LangSmith

- Prebuilt middleware  
  https://docs.langchain.com/oss/python/langchain/middleware/built-in
- Models / init_chat_model / model profiles / reasoning  
  https://docs.langchain.com/oss/python/langchain/models
- Tools  
  https://docs.langchain.com/oss/python/langchain/tools
- LangGraph Generative UI  
  https://docs.langchain.com/langsmith/generative-ui-react
- Agent Server application structure / langgraph.json / CLI  
  https://docs.langchain.com/langsmith/application-structure

### shadcn/ui

- CLI  
  https://ui.shadcn.com/docs/cli
- Vite  
  https://ui.shadcn.com/docs/installation/vite
- Tailwind v4 + React 19  
  https://ui.shadcn.com/docs/tailwind-v4

---

## 当前执行状态

- [x] 2026-09-21：完成全栈官方文档对照审计。
- [x] 2026-09-21：识别 Runtime patch、Tool live parser、Tool lifecycle 重复状态机、Context Display 手写实现、middleware 顺序等关键偏离。
- [x] 2026-09-21：将原“前端替换 TODO”升级为全栈官方优先执行计划。
- [ ] R0 固化基线测试。
- [ ] R1 Tool middleware 收敛。
- [ ] R2 Tool UI / Data UI 官方化。
- [ ] R3 Context Display / Model Profile 收敛。
- [ ] R4 threadId patch 收窄。
- [ ] R5 依赖清理。
- [ ] R6 可选极简化。
