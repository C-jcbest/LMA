# LMA 全栈官方优先重构 TODO

> 目标分支：`codex/official-stack-refactor`
> 复核基线：`09ab59f9739027db22f92cb90af6e47f396933de`
> 更新时间：2026-09-21
>
> 本文合并并替代：
>
> - `docs/official-stack-refactor.md`
> - `docs/重构 TODO.md`
>
> 后续重构以本文为唯一架构与 TODO 标准。旧文档仅保留审计历史，不再分别维护完成状态。
>
> 本轮允许破坏式重构，不要求兼容旧前端、旧 Tool UI 或旧消息展示结构。保留 LMA 核心监测能力与当前基本视觉风格，不为历史实现保留双轨兼容代码。

------

## 1. 最终目标

LMA 最终只长期维护三类代码：

1. **领域能力**
   - 北斗/GNSS 数据查询；
   - 监测点与分组；
   - 天气关联；
   - GNSS 图形与视觉复核；
   - 场地环境；
   - 领域提示词、调查逻辑与证据组织。
2. **领域展示**
   - Station Renderer；
   - GNSS Renderer；
   - Weather Renderer；
   - Vision Renderer；
   - Site Environment Renderer；
   - 少量 LMA 特有的状态与结果展示。
3. **确有上游缺口的最小适配器**
   - 必须有明确原因；
   - 必须有独立回归测试；
   - 必须记录删除条件；
   - 上游支持后立即删除；
   - 不得扩张成新的通用框架。

其余通用能力尽可能交给官方栈：

| 能力                             | 负责人                              |
| -------------------------------- | ----------------------------------- |
| Agent/ReAct 循环                 | LangChain `create_agent`            |
| 模型/工具重试                    | LangChain Middleware                |
| Tool Error                       | LangChain Middleware                |
| 调用预算                         | LangChain Middleware                |
| 长上下文摘要                     | `SummarizationMiddleware`           |
| Thread / Run / Checkpoint        | LangGraph Agent Server              |
| Streaming                        | `@langchain/react`                  |
| React Agent Runtime              | `@assistant-ui/react-langchain`     |
| Thread UI / Composer / Reasoning | assistant-ui                        |
| Tool 状态与 Renderer 注册        | assistant-ui Toolkits               |
| Markdown                         | assistant-ui Streamdown             |
| Dialog / Tooltip / Dropdown 等   | shadcn/ui / Radix                   |
| Context Ring                     | assistant-ui Context Display        |
| LangGraph 开发/构建              | `langgraph dev` / `langgraph build` |
| 前端构建                         | Vite                                |

核心原则：

> **官方负责通用机制，LMA 只负责领域差异。**

------

# 2. 当前架构中应继续保留的部分

以下实现方向已经正确，不应为了“重构”重新手写。

### 2.1 后端

| 当前实现                                 | 结论           |
| ---------------------------------------- | -------------- |
| `langchain.agents.create_agent`          | 保留           |
| `SummarizationMiddleware`                | 保留           |
| `ModelRetryMiddleware`                   | 保留           |
| `ToolRetryMiddleware`                    | 保留并调整顺序 |
| `ToolErrorMiddleware`                    | 保留并收敛职责 |
| `ModelCallLimitMiddleware`               | 保留           |
| `ToolCallLimitMiddleware`                | 保留           |
| LangChain `@tool`                        | 保留           |
| Pydantic Tool Args                       | 保留           |
| `response_format="content_and_artifact"` | 保留           |
| `init_chat_model`                        | 保留           |
| `langgraph.json` graph factory           | 保留           |
| Agent Server Thread/Checkpoint           | 保留           |

禁止重新建立：

- 手写 ReAct StateGraph；
- ToolNode 调度循环；
- 自建 Thread 数据库；
- FastAPI 再代理一层 Agent Stream；
- 自建 retry engine；
- 自建模型调用状态机。

### 2.2 前端

当前技术栈继续保留：

- React 19；
- Vite；
- TypeScript；
- Tailwind CSS v4；
- assistant-ui；
- `@assistant-ui/react-langchain`；
- `@langchain/react`；
- `@langchain/langgraph-sdk`；
- shadcn/ui；
- Streamdown。

继续保持：

```text
左侧 Thread List
        +
中央 Chat Thread
```

不改为三栏工作台。

assistant-ui Elements 位于项目源码中是正常设计：

```text
thread.aui.tsx
thread-list.aui.tsx
reasoning.aui.tsx
...
```

这些组件本身就是通过 registry/CLI 分发的可修改源码，因此不属于重复造轮子。

要求是：

> 通过官方 CLI/registry 同步上游，不手工复制一套“类似 assistant-ui”的组件。

------

# 3. 两份旧 TODO 的冲突裁决

## 3.1 assistant-ui patch：目标应为完全删除

当前：

```text
frontend/patches/@assistant-ui__react-langchain@0.0.32.patch
```

主要解决：

1. controlled `threadId`；
2. summarization message 展示。

最终方案不继续 patch 第三方 Runtime。

### Thread URL

不要让 URL 成为第二个 Thread 状态源。

目标：

```text
URL
 ↓ 仅用于导航
ThreadListRuntime
 ↓
当前 Thread
```

实现：

- Runtime 是 Thread 选择的唯一事实源；
- 初次进入 `?threadId=x`：
  - 等待 Thread List 加载；
  - 调用公共 `switchToThread(x)`；
- `popstate` 同样调用公共 Runtime Action；
- 用户从 Thread List 切换成功后，再同步 URL；
- URL 不直接控制 `useStreamRuntime` 内部状态。

不得重新实现：

- message hydrate；
- stream reconnect；
- thread cache；
- active run 状态。

### Summary Message

不再为了摘要展示修改 LangChain Message Role。

LangChain SummarizationMiddleware 生成的内部消息继续保持原本语义。

assistant-ui converter 已保留：

```text
additional_kwargs
    ↓
message.metadata.custom
```

因此本地 Message Renderer 根据：

```text
metadata.custom.lc_source === "summarization"
```

决定显示：

```text
更早的对话已压缩为摘要
[展开]
```

即可。

不需要把 HumanMessage 强行转换为 SystemMessage。

### 完成标准

-  删除 `pnpm.patchedDependencies`
-  删除 `frontend/patches/@assistant-ui__react-langchain@0.0.32.patch`
-  deep-link 正常
-  浏览器前进/后退正常
-  运行中切 Thread 再返回正常
-  刷新 Thread 正常
-  Summary 不再显示为普通用户气泡
-  Message 语义不被项目篡改

------

## 3.2 Tool Artifact 与 Data UI：不强制迁移 Data UI

旧 TODO 中存在两种方向：

```text
ToolMessage.artifact
```

与：

```text
LangGraph Data UI
```

两者并不冲突，但用途不同。

### 默认方案：Toolkit + ToolMessage.artifact

LMA 当前的：

- GNSS；
- Weather；
- Vision；
- Station；
- Site Environment；

本质上都是某个具体 Tool Call 的结果。

因此继续使用：

```text
LangChain Tool
    ↓
content + artifact
    ↓
ToolMessage
    ↓
assistant-ui ToolCall Part
    ↓
Toolkit Renderer
```

这是最直接的方案。

`content`：

> 给模型使用的精炼事实。

`artifact`：

> 给 UI 使用的结构化业务数据、图像信息、曲线数据等。

不需要为了“官方化”再增加：

```text
Tool
 ↓
push_ui_message
 ↓
custom channel
 ↓
Data UI
```

### Data UI 什么时候使用

仅在 UI **不属于某一个 Tool Call 本身**时使用，例如：

- Agent 节点主动插入一个调查总览；
- 后端决定展示一个独立 dashboard；
- 多个工具联合形成一个新的复合 UI；
- Graph 节点输出 UI，而不是 Tool 输出 UI。

即：

```text
Tool 决定结果展示
→ Toolkit

Graph / Orchestrator 决定插入 UI
→ Data UI
```

本轮不为了迁移而迁移。

------

# 4. P0：优先解决的架构问题

## P0-01 Tool Retry / Error Middleware 顺序语义与职责收敛

文档复核时的装配顺序：

```text
ModelRetry
ToolError
ToolRetry
```

LangChain 的 middleware 列表按“前项包裹后项”组合，因此上述列表的实际工具执行顺序是：

```text
ToolError（外层最终脱敏）
  ↓
ToolRetry（内层判断并重试）
  ↓
Tool
```

不得仅按名称阅读顺序交换为 `[ToolRetryMiddleware, ToolErrorMiddleware]`；那会让内层 `ToolErrorMiddleware` 在第一次失败时直接返回 `ToolMessage`，外层 Retry 无异常可重试。目标行为是：

```text
工具异常
 ↓
ToolRetry 判断是否 transient
 ↓
重试
 ↓
重试耗尽
 ↓
ToolError 转换为安全 ToolMessage
```

职责必须唯一。

### 同时删除第二套 Tool Error 状态机

当前：

```text
LmaMiddleware.awrap_tool_call
```

还负责：

- 捕获 `ToolFailure`；
- 捕获 `BeidouApiError`；
- 手动 new `ToolMessage`；
- 为 error ToolMessage 补 artifact；
- 再分类 infrastructure/business/internal。

这与：

```text
ToolRetryMiddleware
+
ToolErrorMiddleware
```

重复。

目标：

```text
ToolRetryMiddleware
  → 是否重试

ToolErrorMiddleware
  → 最终异常如何安全呈现
```

`LmaMiddleware` 不再手工构造 ToolMessage。

保留一个非常薄的领域异常分类即可，例如：

```text
ToolFailure
BeidouApiError
```

由 `_on_tool_error()` 转换为经过审定的安全文本。

### 验收

-  transient error 按配置重试
-  参数错误不重试
-  业务失败不重试
-  exhausted retry 只有一个最终错误
-  不向模型/UI 暴露内部堆栈和 URL
-  `LmaMiddleware.awrap_tool_call` 删除或不再承担 Tool 生命周期

------

## P0-02 删除自定义 tools channel wire parser

删除：

```text
frontend/src/lib/langgraph/live-tool-results.ts
```

当前代码正在：

```text
useChannel(["tools"])
 ↓
tool-finished
 ↓
event.params.data
 ↓
kwargs / lc_kwargs
 ↓
提取 artifact
 ↓
自建 LiveToolEventsContext
```

这是对 LangGraph wire protocol 的再次解释。

同时 `ToolFallback` 又组合：

```text
assistant-ui status
+
useLangChainToolCalls
+
live tool event
+
persisted ToolMessage.artifact
```

产生了第二套 Tool 生命周期。

目标全部删除。

Tool Renderer 只读取 assistant-ui 已组装好的：

```text
status
result
artifact
isError
timing
```

项目业务代码不再出现：

```text
tool-finished
params.data
lc_kwargs
useChannel(["tools"])
getWireField
LiveToolEventsProvider
```

### 必须保持的行为

-  同批并行 Tool 谁先完成谁先显示完成
-  不等待整个 tool batch
-  空结果也变为 complete
-  Tool Error 正确终止
-  刷新后 artifact 仍存在
-  切 Thread 后回来结果仍存在

若官方 Runtime 在其中某个行为存在真实缺陷，再针对缺陷创建最小复现，而不是提前维护通用 wire parser。

------

## P0-03 Tool Registry 迁移到 assistant-ui Toolkit

当前：

```text
registry.tsx
+
ToolFallback
```

承担：

```text
toolName
→ label
→ status label
→ artifactKind
→ renderer
→ 状态推导
→ artifact 解码
```

应拆开。

### 新结构

新增：

```text
frontend/src/features/monitoring/toolkit.tsx
```

为需要业务 UI 的工具注册 render-only backend tool：

```text
list_station_groups
list_stations
get_daily_gnss_data
query_weather
analyze_gnss_chart
inspect_site_environment
```

概念结构：

```ts
defineToolkit({
  get_daily_gnss_data: {
    type: "backend",
    render: GnssToolUI,
  },
  query_weather: {
    type: "backend",
    render: WeatherToolUI,
  },
})
```

统一注册：

```text
AuiConfig
  ↓
Tools({ toolkit })
```

### `get_current_time`

这是模型辅助工具，没有必要为了统一形式强制做复杂业务 Renderer。

没有专门 UI 时：

- 使用通用 ToolFallback；
- 或按产品需要提供最小显示。

### ToolFallback 的最终职责

ToolFallback 只负责：

```text
未注册工具
+
真正需要的通用 Approval / HITL
```

不再：

- import LMA registry；
- 判断 artifactKind；
- 合并 live artifact；
- 修正 Tool status；
- 路由业务 Renderer。

------

## P0-04 建立 CI 后再继续破坏式重构

当前已有：

```text
backend tests
Vitest
Playwright
pnpm test:gate
```

但没有仓库级自动门禁。

新增：

```text
.github/workflows/ci.yml
```

至少包含：

### Backend

```text
安装依赖
→ unit/integration tests
→ graph import smoke
```

Agent Server E2E 可单独作为可选 job。

真实 LLM、真实北斗账号不得成为 PR 强制门禁。

### Frontend

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build
Playwright critical E2E
```

### 关键 E2E

必须固定：

- 普通问答；
- 单 Tool；
- 2~3 Tool 并行返回；
- 空结果；
- Tool error；
- retry；
- Stop；
- Stop 后继续；
- 运行中切 Thread；
- 回到 Thread 恢复；
- refresh；
- deep-link；
- browser back/forward；
- Summary 后继续；
- GNSS 富结果；
- Vision 图像；
- recommendation。

------

# 5. P1：继续减少项目自建基础设施

## P1-01 收紧 Tool Artifact Schema

继续使用：

```text
content_and_artifact
```

但删除现在的“万能兼容 Envelope”。

当前不应继续允许：

```text
data.images
envelope.images

data.chart_points
envelope.chart_points

data.site_environment
envelope.site_environment
```

同时存在。

也禁止：

```ts
[key: string]: any
data: any
```

作为长期协议。

### 推荐结构

后端建立明确的 Pydantic 类型：

```text
BaseToolArtifact
 ├─ StationArtifact
 ├─ GnssArtifact
 ├─ WeatherArtifact
 ├─ VisionArtifact
 └─ SiteEnvironmentArtifact
```

共享最小字段：

```text
version
kind
status
observedAt
sources
limitations
```

每个 Artifact 的业务字段只允许出现一个位置。

前端对应建立精确 TS 类型。

Renderer：

```text
收到 GnssArtifact
→ 直接渲染
```

而不是：

```text
不知道数据在哪里
→ 一层层 fallback 猜字段
```

### 失败结果

普通异常：

```text
Tool status + safe result
```

即可展示。

不要为了前端错误卡强制给每个异常重新制造一个业务 artifact。

------

## P1-02 用 assistant-ui Context Display 替换手写上下文圆环

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

------

## P1-03 Context Usage 改用 Model Profile + Provider Usage

当前 `context.py` 同时维护：

```text
CONTEXT_MODEL_CONTEXT
CONTEXT_OUTPUT_RESERVE_TOKENS
CONTEXT_SAFETY_MARGIN_TOKENS
CONTEXT_TOKEN_ESTIMATE_FACTOR
CONTEXT_CHARS_PER_TOKEN
count_tokens_approximately
fixed_input estimate
history estimate
```

而模型实际返回：

```text
usage_metadata.input_tokens
```

这套估算主要用于 UI，价值有限。

目标：

```text
实际已使用 Token
→ provider usage_metadata

模型上限
→ model.profile["max_input_tokens"]
```

没有官方 profile 的自定义 endpoint：

```text
init_chat_model(..., profile={...})
```

显式配置最小 profile。

最终 `context_usage` 只需要类似：

```text
input_tokens
output_tokens
total_tokens
max_input_tokens
usage_ratio
model
```

不要在 UI 中把估算值冒充实际使用量。

### Summarization

继续由：

```text
SummarizationMiddleware
```

负责。

若之后希望简化配置，可基于 Model Profile 使用 context fraction 等官方机制，不再建立自己的 context manager。

------

## P1-04 shadcn `cn` 官方迁移

当前已经安装：

```text
cn
```

但项目仍直接依赖：

```text
clsx
tailwind-merge
```

且 `lib/utils.ts` 仍维护旧实现。

执行官方 migration：

```bash
pnpm dlx shadcn@latest migrate cn
```

目标：

```ts
export { cn } from "cn";
```

之后根据真实引用：

```text
pnpm why clsx
pnpm why tailwind-merge
```

决定是否删除 direct dependency。

不得手工猜依赖。

------

## P1-05 清理重复 Radix / 前端依赖

当前 package 同时存在：

```text
radix-ui
@radix-ui/react-*
cn
clsx
tailwind-merge
assistant-stream
zustand
...
```

逐项检查真实 import。

原则：

> 直接依赖必须对应项目代码的直接使用。

不要因为依赖“以后可能用”而保留。

重点检查：

```text
@radix-ui/*
radix-ui
zustand
@assistant-ui/core
assistant-stream
clsx
tailwind-merge
```

如果仅为第三方间接依赖，则不需要在 LMA `dependencies` 重复声明。

每批依赖清理后执行：

```text
pnpm test
pnpm build
```

------

## P1-06 assistant-ui Elements 建立官方升级流程

不要把 Elements 当作一次性复制的源码。

升级流程统一为：

```text
assistant-ui CLI 检查更新
→ diff
→ 更新官方基础逻辑
→ 重新应用极少量 LMA className/slot 改动
→ test
```

允许修改：

- LMA spacing；
- 字体；
- 边框；
- 宽度；
- 中文文案；
- 必要 slots。

避免长期修改：

- Runtime lifecycle；
- Tool status；
- Message state；
- Thread switching；
- Streaming plumbing。

------

## P1-07 明确部署边界

当前：

```text
langgraph build
PostgreSQL
Redis
Docker Compose
```

这条路线本身可继续使用。

但 Compose 应明确为：

```text
本地持久化开发
/
论文演示
/
小规模自托管验证
```

不要把 Compose 文档描述成完整 production-grade 部署标准。

### Compose 补充

检查并补齐：

```text
DATABASE_URI
REDIS_URI
LANGSMITH_API_KEY
LANGGRAPH_CLOUD_LICENSE_KEY
```

以及：

```text
Agent Server healthcheck
PostgreSQL healthcheck
Redis healthcheck
```

### 真正生产部署

如果以后确实需要生产级集群：

```text
官方 LangSmith / LangGraph Helm 路线
+
Kubernetes
```

不要自行维护一整套 Kubernetes manifests。

论文/研究系统当前没有必要提前引入 Kubernetes。

------

## P1-08 明确 Vite 前端生产交付

当前 Compose 主要覆盖 Agent Server。

前端保持 Vite，不为了部署改成 Next.js。

目标：

```text
pnpm build
 ↓
dist/
 ↓
Nginx / Caddy / 现有网关
```

推荐同源：

```text
/
→ frontend

/langgraph-api
→ Agent Server
```

生产环境不允许最终用户随意修改 Agent Server endpoint。

Service Settings 仅在开发环境或管理员模式暴露。

------

# 6. P2：可优化，但不是当前架构阻塞项

## P2-01 `_sanitize_unanswered_tool_calls`

当前：

```text
_sanitize_unanswered_tool_calls
```

是 Stop 后清理悬空 Tool Call 的 workaround。

不直接删除，也不默认长期保留。

先建立真实 Agent Server E2E：

```text
启动并行工具
→ Stop
→ refresh
→ 发下一条消息
→ 切 Thread
→ 再返回
```

如果官方：

```text
assistant-ui
+
@langchain/react
+
Agent Server
```

已经保持合法 tool-call pairing：

> 删除 sanitizer 与对应 `abefore_agent` 修复。

如果仍能稳定复现协议错误：

> 只保留最小 workaround，并记录上游 issue、最小复现和删除条件。

禁止把它继续扩展成“历史 Message 自动修复框架”。

------

## P2-02 DeepSeek Thinking Adapter

`DeepSeekThinkingChatModel` 当前解决：

```text
thinking
+
multi-turn tool calling
+
reasoning_content round-trip
```

的供应商/集成缺口。

继续暂时保留。

必须新增独立测试：

```text
第 1 轮产生 reasoning + tool call
 ↓
第 2 轮请求
 ↓
确认 reasoning_content 被正确回传
```

依赖升级时：

```text
先换回官方 ChatDeepSeek
→ 跑测试
→ 若通过
→ 删除整个 subclass
```

不得向该 subclass 继续塞：

- retry；
- prompt 修复；
- structured output 修复；
- 其他 Provider 的兼容逻辑。

------

## P2-03 模型 Reasoning 参数标准化

继续以：

```text
init_chat_model
```

作为统一入口。

对于当前 LangChain integration 已支持的模型参数，应使用标准参数，而不是自行构造请求 body。

例如支持版本满足要求时：

```text
reasoning_effort
```

直接传给官方模型接口。

仅保留真正存在供应商差异的极窄 adapter。

不要通过模型名称字符串推测 Provider。

------

## P2-04 Recommendation 是否拆独立 Run

当前：

```text
aafter_agent
→ generate_recommendations
```

意味着：

```text
正文已经生成
但主 Run 仍要等待推荐 LLM
```

这不是错误。

暂时继续保留。

先记录：

```text
正文完成时间
主 Run terminal 时间
recommendation latency
```

如果实际造成明显等待，再改成：

```text
主回答完成
 ↓
独立辅助 graph/run
 ↓
recommendations
```

不要在前端建立推荐状态机。

推荐始终只是一次轻量结构化调用，不扩张成第二个 Agent。

------

## P2-05 session-title 图

当前：

```text
assistant-ui generateTitle
→ session-title graph
→ thread.metadata.name
```

属于合理的官方扩展 seam，不是需要修复的架构错误。

默认保留。

只有在确认：

```text
AI 标题没有明显产品价值
```

时，才做进一步极简化：

```text
首条用户消息截断
/
用户手动 rename
```

届时才删除：

```text
title.py
session-title graph
generateSessionTitle
相关直接依赖
```

因此这项不列入必做重构。

------

# 7. 最终目标架构

```text
Browser / Vite React
│
├─ AssistantRuntimeProvider
│   │
│   ├─ @assistant-ui/react-langchain
│   │      └─ useStreamRuntime
│   │           └─ @langchain/react useStream
│   │                └─ LangGraph Agent Server
│   │
│   ├─ assistant-ui Thread
│   ├─ assistant-ui ThreadList
│   ├─ assistant-ui Composer
│   ├─ assistant-ui Reasoning
│   ├─ assistant-ui Markdown / Streamdown
│   ├─ assistant-ui Context Display
│   │
│   └─ LMA Toolkit
│          ├─ Station Renderer
│          ├─ GNSS Renderer
│          ├─ Weather Renderer
│          ├─ Vision Renderer
│          └─ Site Environment Renderer
│
└─ shadcn/ui / Radix
       ├─ Dialog
       ├─ Dropdown
       ├─ Tooltip
       ├─ Popover
       ├─ Collapsible
       └─ Toast / Sonner


LangGraph Agent Server
│
├─ lma-agent
│   │
│   └─ LangChain create_agent
│       │
│       ├─ SummarizationMiddleware
│       ├─ ModelCallLimitMiddleware
│       ├─ ToolCallLimitMiddleware
│       ├─ ModelRetryMiddleware
│       ├─ ToolRetryMiddleware
│       ├─ ToolErrorMiddleware
│       │
│       ├─ LMA minimal middleware
│       │   ├─ business timestamp
│       │   ├─ context usage projection
│       │   └─ recommendations
│       │
│       └─ LMA domain tools
│
├─ session-title
│   └─ optional small stateless graph
│
├─ PostgreSQL
│   └─ Threads / Runs / Checkpoints
│
└─ Redis
    └─ Agent Server runtime infrastructure
```

------

# 8. 明确禁止重新出现的实现

后续 PR 不得重新增加：

```text
第二套前端 Message Store
第二套 Thread Store
第二套 Run 状态机
自定义 SSE/WebSocket transport
手工 LangGraph wire parser
tool-finished event parser
Message accumulator
Tool status enum
Tool lifecycle merger
ToolFallback 项目级业务路由器
node_modules / dependency patch
手写 ReAct loop
手写 ToolNode loop
FastAPI Agent Stream proxy
第二套 retry/error engine
为了旧格式存在的 Compat / Legacy 双轨分支
```

通用 UI 不手写：

```text
Dialog
Tooltip
Dropdown
Popover
Collapsible
Toast
Context Ring
```

除非官方组件确实无法满足需求，并在本文登记原因。

------

# 9. 推荐执行顺序

## R0 — 固化回归基线与 CI

- [x] 后端全部测试通过（69 项，67 通过、2 项显式隔离 Server E2E）
- [x] 前端 Vitest 通过（58 项）
- [x] Playwright 通过（4 项关键浏览器场景）
- [x] Production build 通过
- [x] 新增 GitHub Actions
- [x] 固化 Stop / parallel tools / refresh / thread switching 等关键 E2E

完成 R0 前，不进行大规模删除。

------

## R1 — 后端 Tool Middleware 收敛

- [x] 复核官方 middleware 组合语义：`ToolErrorMiddleware` 必须包裹 `ToolRetryMiddleware`
- [x] 统一 `_on_tool_error`
- [x] 先迁移需要保留部分证据的错误结果，再删除 `LmaMiddleware.awrap_tool_call` 中重复 Tool 生命周期
- [x] ToolFailure/BeidouApiError 收敛
- [x] 验证 retry 次数
- [x] 验证错误脱敏
- [x] backend tests 全绿

这是第一项实际代码重构。

------

## R2 — Tool UI 官方化

- [x] 建立 `features/monitoring/toolkit.tsx`
- [x] 迁移 Station Tool
- [x] 迁移 GNSS
- [x] 迁移 Weather
- [x] 迁移 Vision
- [x] 迁移 Site Environment
- [x] ToolFallback 恢复为 generic fallback
- [x] 删除 Tool Registry 通用 lifecycle 逻辑
- [x] 删除 `live-tool-results.ts`
- [x] 删除 `LiveToolEventsProvider`
- [x] 只读 ToolCall part 的 `status/result/artifact/isError/timing`

重点验证：

- [x] 并行 Tool 分别完成
- [x] 空结果 complete
- [x] error 正常
- [x] artifact refresh 恢复
- [x] image refresh 恢复

------

## R3 — Tool Artifact 强类型化

- [x] 后端建立明确 Pydantic Artifact Schema
- [x] 每类字段只存在一个位置
- [x] 前端建立对应 TS Types
- [x] 删除 `any`
- [x] 删除 index signature
- [x] 删除字段位置 fallback
- [x] Renderer 不再猜 JSON

不引入新的自定义 transport。

------

## R4 — 删除 assistant-ui patch

- [x] URL -> Runtime 使用公共 ThreadListRuntime action
- [x] Runtime -> URL 单向同步
- [x] popstate E2E
- [x] deep-link E2E
- [x] Summary 根据 metadata 自定义渲染
- [x] 删除 patched dependency
- [x] 删除 patch 文件

最终仓库不存在 package patch。

------

## R5 — Context 与前端组件收敛

-  安装 assistant-ui Context Display
-  替换手写 CircularProgress
-  Context 最大值改 Model Profile
-  实际用量只使用 provider usage
-  删除无价值的 fixed/history Token 估算
-  删除对应配置项
-  `shadcn migrate cn`
-  清理 `clsx` / `tailwind-merge`
-  检查重复 Radix 依赖

------

## R6 — Elements / 依赖升级治理

-  assistant-ui Elements 与 registry 对比
-  只保留必要 LMA 样式差异
-  `pnpm why` 检查 direct dependencies
-  删除未使用依赖
-  不修改第三方 runtime internals
-  全部测试与 build 通过

------

## R7 — 后端例外复核

### Stop

-  真实 Agent Server Stop E2E
-  官方链路正常则删除 sanitizer
-  如仍失败，留下最小 workaround

### DeepSeek

-  reasoning_content round-trip 回归测试
-  尝试官方 integration
-  上游修复后删除 adapter

### Recommendation

-  测量主回答与 terminal latency
-  仅在延迟明显时拆独立辅助 run

------

## R8 — 部署与文档清理

-  Compose 定位改成开发/小规模自托管
-  补 standalone Server 必要环境变量说明
-  增加 healthcheck
-  明确 Vite production static hosting
-  配置同源 Agent Server proxy
-  真正生产需求才引入官方 Helm/Kubernetes
-  更新 `project-status.md`
-  两份旧 TODO 标记 archived/superseded
-  本文成为唯一 TODO

------

# 10. 文件级处理建议

## 保留

```text
backend/app/beidou/**
backend/app/agent/tools.py
backend/app/agent/weather.py
backend/app/agent/vision.py
backend/app/agent/site.py
backend/app/agent/prompting.py
backend/langgraph.json

frontend/src/features/monitoring/** 中纯业务 Renderer
frontend/src/components/assistant-ui/elements/** 官方 Elements
frontend/src/components/ui/** 官方 shadcn 组件
RemoteThreadListAdapter
```

## 显著简化

```text
backend/app/agent/graph.py
backend/app/agent/context.py
backend/app/agent/models.py
backend/app/agent/tool_protocol.py

frontend/src/app/providers/AssistantProvider.tsx
frontend/src/components/assistant-ui/elements/tool-fallback.aui.tsx
frontend/src/components/assistant-ui/elements/context-usage.aui.tsx
frontend/src/features/monitoring/tools/registry.tsx
frontend/src/types/envelope.ts
frontend/src/lib/utils.ts
```

## 确定删除

R2 完成：

```text
frontend/src/lib/langgraph/live-tool-results.ts
LiveToolEventsProvider 相关代码
旧 Tool Registry lifecycle 分发
```

R4 完成：

```text
frontend/patches/@assistant-ui__react-langchain@0.0.32.patch
package.json 中 patchedDependencies
```

R5 完成且无其他引用：

```text
frontend/src/components/ui/circular-progress.tsx
clsx direct dependency
tailwind-merge direct dependency
```

## 条件删除

官方 cancel 已解决：

```text
_sanitize_unanswered_tool_calls
对应 abefore_agent 修复
```

DeepSeek 上游已修复：

```text
DeepSeekThinkingChatModel
相关特殊 payload adapter
```

决定不需要 AI 标题时：

```text
backend/app/agent/title.py
session-title graph
generateSessionTitle
仅为其存在的直接依赖
```

------

# 11. 最终验收标准

## 架构

-  主 Agent 仍使用 `create_agent`
-  无手写 ReAct loop
-  Thread / Run / Checkpoint 由 Agent Server 管理
-  前端只有一个 assistant-ui Runtime
-  Graph State 是消息事实源
-  URL 只是 Thread 导航层
-  无自定义 LangGraph wire protocol parser
-  无 package patch
-  已知 Tool 使用 Toolkit
-  未知 Tool 才使用 ToolFallback
-  Tool Error/Retry 只有一套负责人
-  上游 workaround 均有测试与删除条件

## UI

-  保持左侧 Thread List + 中央 Chat
-  不使用三栏布局
-  Tool 与 Reasoning 同层
-  不恢复“监测操作”二级折叠
-  Tool 默认不暴露内部函数名
-  不显示原始调试 JSON
-  Station/GNSS/Weather/Vision 保持轻量风格
-  Thinking 展开不导致页面抖动
-  Context 使用官方 Element
-  Dialog/Tooltip/Popover 等来自 shadcn/Radix

## Streaming

-  同轮并行 Tool 独立完成
-  空结果能完成
-  Tool Error 不永久 loading
-  Stop 正确
-  Stop 后可继续对话
-  运行中切 Thread 再回来仍可观察 Run
-  refresh 后历史 Tool UI 可恢复
-  artifact 可恢复
-  Vision 图像可恢复
-  Summary 后继续对话正常

## 工程质量

-  Backend tests 全绿
-  Frontend Vitest 全绿
-  Playwright 全绿
-  `pnpm build` 全绿
-  CI 自动执行
-  `git diff --check` 通过
-  无密钥、真实账号和敏感配置提交
-  无已经退出主链的 dead code
-  无为了旧实现而存在的长期兼容分支

------

# 12. 后续开发规则

以后新增任何基础设施代码之前，依次判断：

```text
1. LangChain / LangGraph 是否已有官方能力？
       ↓ 否
2. assistant-ui 是否已有 Runtime / Primitive / Element / Toolkit？
       ↓ 否
3. shadcn/ui / Radix 是否已有组件？
       ↓ 否
4. 官方 CLI / registry 是否能直接生成？
       ↓ 否
5. 才允许新增项目自定义基础设施。
```

若必须新增 workaround，则同时记录：

```text
为什么官方能力不足
当前 workaround 文件
上游 issue / 最小复现
覆盖测试
删除条件
```

不允许出现：

> “为了兼容旧实现先同时保留两套，之后再删。”

本项目允许破坏式重构，因此应该直接迁移到目标架构。

------

# 13. 当前执行状态

基线 `09ab59f9739027db22f92cb90af6e47f396933de` 之后已完成：

-  React / Vite / TypeScript / Tailwind 主技术栈升级
-  assistant-ui Runtime 已进入主链
-  Thread / ThreadList / Composer / Reasoning 等已大体迁移官方组件
-  LangChain `create_agent` 已进入主链
-  官方 Summarization / Retry / CallLimit Middleware 已采用
-  LangGraph Agent Server / Thread 持久化已采用
-  Tool 使用 `content_and_artifact`
-  Streamdown 已采用
-  shadcn/Radix 已用于大部分通用 UI
-  R0 仓库级 GitHub Actions 与本地回归基线已建立
-  R1 后端 Tool Middleware 与错误生命周期已收敛
-  R2 已知监测工具已迁移 assistant-ui Toolkit，旧 tools channel/Registry 已删除
-  R3 Artifact 已收敛为后端 Pydantic、前端判别联合与唯一 `artifact.data` 业务字段位置
-  R4 已通过公共 Thread action 完成 URL 双向导航，摘要按 LangChain metadata 渲染，依赖 patch 已删除

当前剩余的真正架构性工作：

-  R5 Context Display / Model Profile / `cn`
-  R6 依赖与 Elements 收敛
-  R7 Stop / DeepSeek 例外复核
-  R8 部署与文档清理

完成这些工作以后，LMA 的前后端结构应基本收敛为：

> **LangChain/LangGraph 负责 Agent 与运行时，assistant-ui 负责聊天交互与 Tool 生命周期，shadcn 负责通用 UI，LMA 自己只维护滑坡监测领域逻辑、领域数据协议与领域展示。**
