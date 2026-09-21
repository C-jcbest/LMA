# LMA 全栈官方化重构计划

> 审查基线：`feat/frontend-refactor` @ `0b06cedffdab10b454b3f2ff1352377726f63cf4`（2026-09-21）
>
> 本文是当前“官方栈优先”重构的权威入口。允许删除和重写现有实现，不要求兼容旧前端/旧消息展示；保留 LMA 核心业务能力、北斗/GNSS 数据调查能力和现有基本视觉语言。

## 1. 目标与判断原则

目标不是“减少所有自定义代码”，而是只保留 LMA 必须拥有的代码：

1. LMA 领域能力：GNSS/北斗查询、气象、视觉复核、场地环境、领域提示词与证据组织。
2. LMA 领域展示：GNSS 曲线、站点、天气、视觉复核、环境信息等 Renderer。
3. 供应商/上游真实缺口的最小适配器，并且必须有删除条件、回归测试和上游证据。
4. LMA 视觉 token 与少量布局样式。

以下能力优先交给官方组件/API/SDK/CLI，而不是项目自建状态机：

- Agent/ReAct 循环、工具调度、重试、调用预算、摘要；
- Thread / Run / Checkpoint / streaming；
- React 侧线程切换、运行状态、取消、再生成、消息转换；
- Tool call 状态投影与工具 UI 注册；
- Thread / Composer / Markdown / Reasoning / Tool shell；
- Dialog / Tooltip / Dropdown / Collapsible / Toast 等通用 UI；
- LangGraph 构建、开发服务和生产镜像构建。

## 2. 当前总体结论

### 2.1 应继续保留的实现

| 区域 | 当前实现 | 结论 | 原因 |
| --- | --- | --- | --- |
| 主 Agent | `langchain.agents.create_agent` + 官方 middleware | **保留** | 这是当前 LangChain 高层 Agent 推荐入口；不应退回手写 ReAct StateGraph/ToolNode 循环。 |
| 重试/预算/摘要 | `ModelRetryMiddleware`、`ToolRetryMiddleware`、`ToolErrorMiddleware`、CallLimit、`SummarizationMiddleware` | **保留** | 已优先使用官方 middleware。 |
| Agent Server | `langgraph.json` + graph factory | **保留** | 符合 LangGraph Agent Server 应用结构。 |
| CLI | `langgraph dev` / `langgraph build` | **保留** | 官方 CLI 路径。 |
| 前端 Runtime | `@assistant-ui/react-langchain` + `@langchain/react` | **保留** | 当前 assistant-ui 官方模板优先的 LangGraph React 连接方式之一。 |
| Thread 数据源 | LangGraph Thread API | **保留** | 不另建前端会话数据库。 |
| Thread List Adapter | `RemoteThreadListAdapter` 映射 `client.threads.*` | **保留并瘦身** | assistant-ui 官方支持自有数据库/线程源的扩展路径；LangGraph thread_id 可直接作为 externalId。 |
| Tool 后端契约 | LangChain `@tool(response_format="content_and_artifact")` + `ToolMessage.status/artifact` | **保留** | 属于 LangChain 官方工具协议。 |
| assistant-ui Elements | `thread.aui.tsx`、`thread-list.aui.tsx` 等本地源码 | **保留但通过 CLI 同步** | Elements 本来就是 registry/CLI 拷贝进项目、允许本地改样式的源码，不属于“重复造轮子”。 |
| shadcn/Radix | `components/ui` | **保留并升级** | 通用 UI 应继续落到 shadcn/Radix。 |
| 模型工厂 | `init_chat_model` 为主 | **保留** | 已优先使用官方模型初始化入口。 |

### 2.2 允许保留的“上游例外”

这些不是理想终态，但目前有明确上游原因，禁止为了代码纯洁度直接删除。

#### EX-01 DeepSeek thinking + tool calling 请求适配

证据：
- `backend/app/agent/models.py::DeepSeekThinkingChatModel` 仅覆写请求 payload，将上一轮 `AIMessage.additional_kwargs.reasoning_content` 写回。
- 截至本审查，LangChain 最新主干 `ChatDeepSeek._get_request_payload` 仍没有该 round-trip。
- LangChain issue #39370 明确记录 v1.1.0 在 thinking + multi-turn tool calling 下的该问题。

处理：
- 暂时保留这个极窄 adapter。
- 增加一个专门回归测试：两轮 tool call 时 reasoning_content 必须进入第二次请求。
- 在依赖升级 PR 中先用官方 `ChatDeepSeek` 跑该测试；一旦上游通过，立即删除 subclass。
- 不允许继续向该 subclass 增加其他供应商兼容逻辑。

#### EX-02 Stop 后悬空 tool-call 清洗

证据：
- `backend/app/agent/graph.py::_sanitize_unanswered_tool_calls` 是当前项目自有协议修复。
- 它的存在来自“取消发生在 AI 已产生 tool_call、ToolMessage 尚未持久化”的边界情况。

处理：
- 不立刻删除。
- 先用真实 Agent Server E2E 验证 `stop({cancel:true})` 后 checkpoint 是否已经能被下一轮官方模型直接消费。
- 如果官方链路已经保持 tool-call 配对，删除该函数和 before-agent 修复。
- 如果仍会留下不合法历史，则保留为单一 middleware workaround，并记录最小复现/上游 issue；不得把它扩展为通用 message repair 系统。

---

## 3. 偏离项与迁移方案

优先级：P0 = 阻塞官方化/高维护风险；P1 = 下一阶段必须清理；P2 = 工程质量增强。

### FE-001 / P0：直接 patch 最新 assistant-ui 依赖

**现状**

`frontend/package.json` 使用：

```json
"patchedDependencies": {
  "@assistant-ui/react-langchain@0.0.32": "patches/@assistant-ui__react-langchain@0.0.32.patch"
}
```

patch 修改两个行为：

1. 给 `useStreamRuntime` 额外加入受控 `threadId/initialThreadId`；
2. 把 LangChain SummarizationMiddleware 产生的 `HumanMessage(additional_kwargs.lc_source="summarization")` 强行改成 assistant-ui `system` role。

**问题**

- 这是对第三方运行时代码的长期 fork；每次上游更新都要重新验证内部实现。
- 当前 assistant-ui 已公开 `ThreadListRuntime.switchToThread()`、`getLoadThreadsPromise()` 等线程动作，URL 不需要成为 Runtime 的第二个受控 owner。
- LangChain 摘要消息本身故意标记 `lc_source=summarization`；assistant-ui converter 已把 `additional_kwargs` 保留到 `message.metadata.custom`，展示层可按 metadata 渲染，无需改消息角色语义。

**迁移**

1. 删除传给 `useStreamRuntime` 的自定义 `threadId`。
2. URL 只做“镜像/导航入口”：
   - Runtime 线程是唯一事实源；
   - 初次加载或 popstate：等待 ThreadList 加载完成后调用官方 `switchToThread(threadId)`；
   - Runtime 切换成功后再更新 `?threadId=`。
3. 摘要消息：在本地 `Thread` Element 的消息 slot 中读取 `message.metadata.custom.lc_source`；值为 `summarization` 时渲染 LMA 的折叠摘要样式，不改 role。
4. 删除 `frontend/patches/@assistant-ui__react-langchain@0.0.32.patch` 和 `pnpm.patchedDependencies`。

**验收**

- `pnpm patch`/patchedDependencies 彻底消失。
- 直接打开 `?threadId=<id>`、前进/后退、生成中切换再返回全部通过 E2E。
- 摘要不显示为用户气泡，但底层 LangChain message 不被篡改。

### FE-002 / P0：手工解析 LangGraph tools channel

**现状**

`frontend/src/lib/langgraph/live-tool-results.ts`：

- `useChannel(stream, ["tools"])`；
- 手工识别 `tool-finished`；
- 手工解析 `value / kwargs / lc_kwargs` wire envelope；
- 再构建一层 `LiveToolEventsContext`。

**问题**

这是对底层 stream 协议的二次投影。当前 `@langchain/react` / `@assistant-ui/react-langchain` 已公开：

- `useLangChainToolCalls`；
- `useLangChainStream` + `useToolCalls`；
- assistant-ui ToolCallMessagePart 原生包含 `result`、`artifact`、`isError`、`timing`；
- tool renderer 原生接收运行状态和结果。

继续解析 `event.params.data` 会把 LMA 绑定到 wire 细节，并与 Runtime 自身 tool lifecycle 重复。

**迁移**

1. 删除 `LiveToolEventsProvider`、`getWireField`、`tool-finished` 解析。
2. 普通业务 Tool UI 直接消费 assistant-ui ToolCall part：`status/result/artifact/isError/timing`。
3. 只有“非 Tool Call、由后端主动决定插入的 UI”才使用 LangGraph Generative UI（`push_ui_message` + `makeAssistantDataUI`），不要把 Generative UI 再实现成自定义 tools channel。
4. 历史恢复继续以持久化 ToolMessage/artifact 为准，交由官方 converter 合并到 tool-call part。

**验收**

- 删除 `frontend/src/lib/langgraph/live-tool-results.ts`。
- 前端业务代码不出现 `tool-finished`、`params.data`、`lc_kwargs`、`useChannel(["tools"])`。
- 并行工具谁先结束谁先变 completed；空结果也能正常 completed。
- 刷新后 artifact 与错误状态仍恢复。

### FE-003 / P0：自建 Tool Registry + ToolFallback 分发，未使用当前 Toolkits 注册模式

**现状**

`features/monitoring/tools/registry.tsx` 自己维护：

- toolName → label/runningLabel/completeLabel/errorLabel；
- toolName → artifactKind；
- toolName → renderer；
- `ToolFallback` 再按 registry 解码和分发。

**问题**

assistant-ui 当前推荐 Toolkits 作为统一工具 UI 注册入口。对于执行发生在 LangGraph 后端的工具，官方支持 render-only backend tool：`defineToolkit({ tool: { type: "backend", render }})`（或 generative compiler 下 `externalTool()`）。

LMA 应保留“GNSS/Weather/Vision 怎么展示”，但不应继续拥有“如何把 tool-call lifecycle 路由到 renderer”的通用框架。

**迁移**

1. 新建 `features/monitoring/toolkit.tsx`。
2. 用 `defineToolkit` 注册后端工具 UI：
   - `list_station_groups`
   - `list_stations`
   - `get_daily_gnss_data`
   - `query_weather`
   - `analyze_gnss_chart`
   - `inspect_site_environment`
3. 每项只保留 LMA 业务 `render` / `renderText`。
4. 通过 `AuiConfig({ tools: Tools({ toolkit }) })` 一次注册。
5. `Thread` 的 `ToolFallback` 只处理未知工具，不再承担 LMA 工具路由。
6. 删除 `toolRegistry` 中通用 lifecycle 分发逻辑。

**验收**

- 已知 LMA 工具都由官方 toolkit resolver 命中。
- `ToolFallback` 不包含 toolName switch/registry 分发。
- 工具状态由 assistant-ui part status 驱动，不自行推导。

### FE-004 / P1：Tool Artifact 协议仍为宽松兼容模型

**现状**

`frontend/src/types/envelope.ts` 存在：

- 大量 `any`；
- `[key: string]: any`；
- “保持向前兼容现有扩展字段”；
- `site_environment/chart_points/images` 同时可能出现在 envelope 顶层或 data 内。

这与“本轮无需兼容旧架构”的要求相反。

**迁移**

二选一，优先 A：

A. Toolkits + 每工具强类型 artifact：
- Renderer 直接对该工具的 `artifact` 做单一 schema narrowing；
- GNSS/Weather/Vision 各有明确类型；
- 不再维护一个能容纳所有旧结构的万能 envelope。

B. 如继续统一 envelope：
- 后端用 Pydantic 定义 discriminated union；
- 前端生成/同步对应 TS 类型；
- 禁止 index signature、禁止 `any`、禁止同一字段多位置 fallback。

**验收**

- `types/envelope.ts` 不再有兼容型 `[key:string]: any`。
- 每类 artifact 只有一个字段位置和一种合法结构。
- 非法结构在边界处失败，不在 Renderer 内猜测。

### FE-005 / P1：shadcn `cn()` 仍是旧迁移前实现

**现状**

`frontend/src/lib/utils.ts` 手写：

```ts
clsx + tailwind-merge
```

同时 package 已安装新的 `cn` 包。

**迁移**

运行官方迁移并复核：

```bash
pnpm dlx shadcn@latest migrate cn
```

目标：

```ts
export { cn } from "cn";
```

然后清除未再使用的 `clsx` / `tailwind-merge` 直接依赖。

**验收**

- `lib/utils.ts` 不再维护自有 class merge 实现。
- `pnpm why clsx tailwind-merge` 仅允许作为第三方间接依赖存在。

### FE-006 / P1：assistant-ui Elements 更新没有形成可重复流程

**现状**

Elements 已放在正确目录，但当前文档把“本地文件存在”当完成标准，缺少定期与 registry 对齐的方法。

**迁移**

将以下命令加入升级流程，而不是手工复制上游代码：

```bash
pnpm dlx assistant-ui@latest update --dry
pnpm dlx assistant-ui@latest upgrade
pnpm dlx assistant-ui@latest add thread thread-list
```

只在 LMA 需要的 slots/classes 上保留定制。升级时对比 registry 版本，避免长期 fork Elements 的内部 lifecycle。

### BE-001 / P1：自定义协议修复需要“例外治理”，不能无限增长

涉及：

- `_sanitize_unanswered_tool_calls`
- `DeepSeekThinkingChatModel`

它们当前都有合理原因，但必须进入“有删除条件的例外清单”，不能成为继续添加兼容逻辑的入口。

**验收**

- 每个 workaround 对应一个最小测试；
- 注释包含上游 issue/删除条件；
- 依赖升级时 CI 专门验证是否可删除。

### BE-002 / P2：推荐问题生成仍占用主 Run 的 after_agent 生命周期

当前 `LmaMiddleware.aafter_agent -> generate_recommendations` 会让主 Run 在最终回答生成后继续等待一次辅助模型调用。

这不是违反官方 API，但会把“回答完成”和“推荐完成”绑定为同一 Run 生命周期。

**建议**

先测真实用户感知：
- 如果推荐模型稳定且延迟很低，可继续使用官方 middleware hook；
- 如果它明显拖慢 Run terminal，则像 `session-title` 一样拆为独立辅助 graph/run，主回答完成后再获取推荐；不要在前端伪造推荐状态机。

不在 P0 阶段为了架构美观强拆。

### INFRA-001 / P0（部署时）：当前 Docker Compose 被文档描述为“生产部署”，与最新官方建议不一致

**现状**

根目录 `docker-compose.yml` 使用：
- `langgraph build` 产物；
- Postgres；
- Redis；
- `DATABASE_URI` / `REDIS_URI`。

这条构建链本身是官方支持的。但当前注释把它称作生产部署，而 LangChain 当前 standalone server 文档明确：
- Docker 适合开发或小规模负载；
- 生产推荐 Kubernetes + maintained LangSmith Helm chart；
- data plane 还要求 `LANGSMITH_API_KEY`、`LANGGRAPH_CLOUD_LICENSE_KEY`；
- 当前 `.env.example` 未包含 `LANGGRAPH_CLOUD_LICENSE_KEY`。

**迁移**

1. 把 compose 定位改成“本地持久化 / 小规模自托管验证”。
2. `.env.example` 增加当前 Agent Server 所需 license 配置与说明。
3. 如果论文/演示只需要单机：继续 Compose，但不要宣称 production-grade。
4. 如果真的上线生产：新增 `deploy/helm/`，基于官方 LangSmith Helm chart 做 values，而不是自建 Kubernetes manifests。
5. 为 lma-agent 增加 healthcheck，并记录升级/迁移流程。

### INFRA-002 / P1：没有仓库级 CI

当前有：
- 后端 unittest；
- 前端 Vitest；
- Playwright；
- `pnpm test:gate`。

但仓库树没有 `.github/workflows`，因此这些门禁依赖人工执行。

**迁移**

新增 `.github/workflows/ci.yml`：

1. backend unit tests；
2. frontend `pnpm install --frozen-lockfile`；
3. `pnpm test`；
4. `pnpm build`；
5. Playwright E2E（可使用现有 stub Agent Server）；
6. 可选的 Agent Server E2E 独立 job，通过显式 flag 启动 `langgraph dev`。

分支保护只要求稳定、可重复的 job；真实模型/真实北斗接口不得作为 PR 必过门禁。

### INFRA-003 / P1：前端没有明确的生产交付路径

当前 Compose 只部署 Agent Server/Postgres/Redis，Vite 前端没有正式生产服务定义。

**迁移**

选择一个简单方案，不引入第二套应用框架：

- Vite `pnpm build` 产出静态 `dist`；
- 用 Nginx/Caddy/现有网关托管；
- 同源反代 `/langgraph-api` 到 Agent Server；
- 生产环境禁用用户任意修改 API endpoint，设置页只在开发模式开放。

不要为了部署改成 Next.js；LMA 当前不需要 SSR。

### DOC-001 / P0：重构文档已经与代码产生漂移

例子：
- `docs/TODO.md` 的旧完成记录称“标题生成生命周期收敛到服务端 LmaMiddleware.aafter_agent”，当前代码实际是 assistant-ui `generateTitle` → `session-title` 独立 graph。
- 旧 `docs/重构 TODO.md` 把“保留 assistant-ui patch”和“live tools channel fallback”写成完成条件，而本次复审已经确认这两项应退出终态。

**处理**

- 本文成为新的官方化重构权威入口。
- `docs/重构 TODO.md` 仅作为此前前端迁移历史，不再作为最终架构标准。
- 后续每个重构 PR 必须同步更新本文对应 ID 的状态和证据。

---

## 4. 目标架构

```text
Browser / Vite React
│
├─ assistant-ui Elements + shadcn
│   ├─ Thread / ThreadList / Composer / Reasoning / generic ToolFallback
│   └─ LMA Toolkit (render-only backend tools)
│       ├─ Station renderer
│       ├─ GNSS renderer
│       ├─ Weather renderer
│       ├─ Vision renderer
│       └─ Site environment renderer
│
├─ @assistant-ui/react-langchain
│   └─ @langchain/react useStream
│       └─ official Thread/Run/ToolCall projections
│
└─ @langchain/langgraph-sdk
    └─ Agent Server API
        │
        ├─ lma-agent
        │   └─ LangChain create_agent
        │       ├─ official middleware
        │       └─ LMA domain tools
        │
        └─ session-title
            └─ small stateless graph

Agent Server
├─ Postgres: threads/runs/checkpoints
└─ Redis: streaming/background queue
```

禁止重新出现：

- 第二套前端 message/thread/run/tool 状态机；
- 手工解析 LangGraph wire event；
- 对 assistant-ui package 打本地 patch；
- ToolFallback 内的项目级工具路由器；
- 为旧 Tool Artifact 结构保留兼容分支；
- 手写 Dialog/Tooltip/Dropdown/Toast；
- 手写 ReAct/ToolNode 循环。

---

## 5. 可执行迁移顺序

### Phase 0：基线与保护

- [ ] 将本文加入 `docs/TODO.md` 首要入口。
- [ ] 记录当前 `pnpm test:gate` 与 backend tests 结果。
- [ ] 增加 CI，保证后续每一步都能独立回滚。
- [ ] 不再向现有 patch/live-tool bridge 增加功能。

### Phase 1：去 assistant-ui patch

- [ ] 新增 URL ↔ ThreadListRuntime 的薄同步组件。
- [ ] 使用 `switchToThread` 实现初始 deep-link / popstate。
- [ ] 按 `metadata.custom.lc_source` 渲染摘要。
- [ ] 删除 patchedDependencies 和 patch 文件。
- [ ] 完成 thread deep-link / back-forward / running-switch E2E。

### Phase 2：工具 UI 官方化

- [ ] 引入 render-only `defineToolkit`。
- [ ] 迁移 6 个 LMA 工具 Renderer。
- [ ] `ToolFallback` 退回真正 fallback。
- [ ] 删除 `LiveToolEventsProvider` 与 tools channel wire parsing。
- [ ] 使用 Runtime/tool part 的 `status/result/artifact/isError/timing`。
- [ ] 收紧 artifact 类型，删除兼容字段和 `any`。

### Phase 3：前端依赖与 Elements 收敛

- [ ] `assistant-ui update --dry` / `upgrade`。
- [ ] `shadcn migrate cn`。
- [ ] 清除无直接使用的依赖。
- [ ] 只保留 LMA 样式修改，不维护 Elements 内部 lifecycle fork。

### Phase 4：后端例外复核

- [ ] 用官方 ChatDeepSeek 运行 reasoning round-trip 测试；仍失败则保留 EX-01。
- [ ] 用真实 Agent Server 测 stop → 下一轮；能原生恢复则删除 EX-02。
- [ ] 保持 `create_agent + middleware`，禁止重新手写循环。
- [ ] 检查 recommendation 是否显著拉长 terminal 时间，再决定是否拆辅助 graph。

### Phase 5：部署收敛

- [ ] 修正 Compose 的定位和注释。
- [ ] 补 `LANGGRAPH_CLOUD_LICENSE_KEY` 等当前 standalone 配置。
- [ ] 增加 Agent Server healthcheck。
- [ ] 明确 Vite production build + static hosting + same-origin proxy。
- [ ] 若需要真正生产部署，再做官方 Helm 路线；否则不引入 Kubernetes。

### Phase 6：清理文档与死代码

- [ ] 删除已被本文替代的错误完成条件。
- [ ] 更新 `project-status.md` 为实际架构。
- [ ] 全仓搜索并删除：`Compat`、`Legacy`、patch workaround（已满足删除条件者）、旧 Tool Registry、旧 stream bridge。
- [ ] 最终只留下“领域逻辑 + 官方扩展边界 + LMA 视觉”。

---

## 6. 最终验收门槛

前端：

- [ ] 只有一个 assistant-ui Runtime。
- [ ] 不 patch node_modules / pnpm dependency。
- [ ] 不手工解析 LangGraph stream wire event。
- [ ] 线程选择由 assistant-ui ThreadListRuntime 管理，URL 只同步。
- [ ] LMA 工具使用 Toolkits 注册，未知工具才走 ToolFallback。
- [ ] Tool Renderer 直接消费官方 ToolCall part 的状态/result/artifact。
- [ ] Thread、ThreadList、Reasoning、Markdown、Composer 等来自 assistant-ui Elements/Primitive。
- [ ] Dialog/Dropdown/Tooltip/Collapsible/Sonner 等来自 shadcn/Radix。
- [ ] `pnpm test`、`pnpm test:e2e`、`pnpm build` 全绿。

后端：

- [ ] 主 Agent 仍为 `create_agent`。
- [ ] 重试、摘要、调用限制仍用官方 middleware。
- [ ] Thread/Checkpoint 由 Agent Server 管理，不自建持久化。
- [ ] 每个上游 workaround 都有独立测试与删除条件。
- [ ] 工具继续采用标准 `content_and_artifact` / ToolMessage status。
- [ ] backend tests 与 Agent Server E2E 全绿。

部署：

- [ ] 开发：`langgraph dev`。
- [ ] 镜像：`langgraph build`。
- [ ] 单机 Compose 被明确标记为开发/小规模自托管。
- [ ] 真正生产环境遵循当前官方 Helm/Kubernetes 路径，或在文档中明确接受自行维护非 K8s 缺口。
- [ ] CI 自动执行核心测试与构建。

## 7. 官方参考

- assistant-ui LangChain Runtime: https://www.assistant-ui.com/docs/runtimes/langchain
- assistant-ui ThreadListRuntime: https://www.assistant-ui.com/docs/api-reference/runtimes/thread-list-runtime
- assistant-ui Threads: https://www.assistant-ui.com/docs/runtimes/concepts/threads
- assistant-ui Toolkits migration: https://www.assistant-ui.com/docs/migrations/toolkit-tools
- assistant-ui Tools: https://www.assistant-ui.com/docs/tools/defining-tools
- assistant-ui CLI: https://www.assistant-ui.com/docs/cli
- assistant-ui LangGraph Generative UI: https://www.assistant-ui.com/docs/runtimes/langgraph/generative-ui
- LangChain Agents: https://docs.langchain.com/oss/python/langchain/agents
- LangChain Middleware: https://docs.langchain.com/oss/python/langchain/middleware
- LangGraph CLI: https://github.com/langchain-ai/langgraph/tree/main/libs/cli
- LangSmith standalone Agent Server: https://docs.langchain.com/langsmith/deploy-standalone-server
- shadcn CLI / migrations: https://ui.shadcn.com/docs/cli
