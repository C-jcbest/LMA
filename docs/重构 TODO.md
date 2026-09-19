# LMA assistant-ui 全面重构 TODO

> 日期：2026-09-19
> 目标分支：`main`
> 改造原则：不兼容旧前端架构，允许删除和重写现有通用聊天层；保留 LMA 业务能力、现有基本视觉风格和 LangGraph 后端业务契约。

## 1. 改造目标

本轮前端改造的核心目标不是继续拆分现有组件，而是减少项目自行维护的 UI 与运行时逻辑。

改造完成后：

- assistant-ui 负责聊天 Thread、Message、Composer、自动滚动、消息动作、停止、重新生成、Reasoning、Tool Call 生命周期和 Thread List 等通用能力。
- `@assistant-ui/react-langchain` 负责 assistant-ui 与现有 `@langchain/react/useStream` / LangGraph Server 的运行时适配。
- shadcn/ui 负责 Button、Dialog、AlertDialog、DropdownMenu、Tooltip、Popover、Skeleton、Collapsible、ScrollArea、Sonner 等通用 UI。
- LMA 仅自行维护 GNSS、天气、视觉分析、站点、场地环境、地图等具有明确业务语义的展示组件。
- 不再自行实现聊天框架、消息状态机、滚动管理、工具生命周期、会话 UI 状态机等通用功能。
- 不为了兼容现有组件保留旧实现或双运行时。
- 页面继续保持当前“左侧会话栏 + 中央聊天区”的布局，不改成三栏工作台。
- 现阶段继续允许工具消息保存大数据、图表数据和 Base64 图片，不在本轮设计对象存储或 Artifact Server。

assistant-ui 官方 Primitives 已经覆盖 Thread、Composer、Message、ActionBar、ThreadList、Suggestion、Error、Tool Call、Reasoning 等聊天基础能力，并负责状态连接、键盘行为、自动滚动和 streaming，因此不得在项目中重新实现同类基础设施。

------

# P0：冻结旧架构，确定新的组件使用规则

-  停止继续扩展当前 `ChatWindow` / `MessageList` / `Composer` / `AssistantTurn` 等旧聊天组件。
-  不再为现有聊天组件增加兼容层。
-  不建立新的自定义消息类型、ToolCall 状态类型或前端 Run 状态机。
-  不自行包装一层 `useExternalStoreRuntime`。
-  新 Runtime 统一使用 `@assistant-ui/react-langchain` 的 `useStreamRuntime`。
-  全局确定以下组件优先级：

```text
assistant-ui Element
        ↓ 不满足
assistant-ui Primitive
        ↓ 不满足
shadcn/ui
        ↓ 不满足
现有成熟第三方组件
        ↓ 最后
LMA 自定义业务组件
```

-  对通用 UI 禁止新增自定义 Button、Dialog、Dropdown、Toast、Tooltip、Collapsible、ScrollArea、Textarea 等实现。
-  assistant-ui / shadcn CLI 安装下来的源码视为“官方组件源码”，原则上只调整 className、tokens、slot 组合和少量 LMA 文案，不重新实现其行为逻辑。

assistant-ui 官方推荐已有项目通过 CLI 初始化，并通过 shadcn registry 安装 Thread、Thread List 等 Elements。

------

# P1：升级前端基础技术栈

## 1.1 更新依赖

-  React 升级到 assistant-ui 当前支持的最新稳定版本。
-  React DOM 同步升级。
-  Vite 升级到当前稳定版本。
-  TypeScript 升级到当前稳定且与 Vite/assistant-ui 兼容的版本。
-  Tailwind CSS 从 v3 升级至 v4。
-  更新 `@langchain/core`。
-  更新 `@langchain/langgraph-sdk`。
-  更新 `@langchain/react`。
-  引入：
  - `@assistant-ui/react`
  - `@assistant-ui/react-langchain`
  - `@assistant-ui/react-streamdown`
-  保留 `lucide-react`。
-  保留 `sonner`。
-  保留 `maplibre-gl`。
-  删除 assistant-ui / shadcn 已经替代的直接 Radix 依赖，除非生成组件仍明确依赖。
-  删除不再需要的 `react-markdown` / `remark-gfm`。

`react-langchain` 是 assistant-ui 针对现代 `@langchain/react/useStream` 提供的较薄 Runtime 层，并直接构建在 `useExternalStoreRuntime` 上；它已经支持 arbitrary LangGraph state、工具调用、重新生成、编辑和 Thread loading 等能力，因此项目不应再次自行适配。

## 1.2 初始化官方组件体系

-  配置 `components.json`。
-  配置 `@/` TypeScript alias。
-  配置 assistant-ui registry。
-  执行 assistant-ui CLI 初始化。
-  使用 CLI 添加需要的官方 Elements。
-  assistant-ui 相关依赖暂时精确锁版本，避免 `react-langchain` 0.0.x 阶段出现自动小版本漂移。
-  后续升级统一通过 assistant-ui `update` / `upgrade` / codemod 处理，不人工长期维护 fork。

------

# P2：用 assistant-ui Runtime 替换当前 `App.tsx` 流式控制层

## 2.1 建立唯一 Runtime Provider

新增：

```text
src/app/providers/AssistantProvider.tsx
```

职责仅包括：

```text
LangGraph Client 配置
        ↓
useStreamRuntime(...)
        ↓
AssistantRuntimeProvider
```

-  使用 `useStreamRuntime`。
-  配置 `assistantId: "lma-agent"`。
-  配置 `messagesKey: "messages"`。
-  开启官方 cancellation 能力。
-  接入 LangGraph Thread List Adapter。
-  不在 Provider 中复制 messages。
-  不建立本地 running 状态。
-  不建立本地 optimistic message 状态。
-  不复制 tool-call lifecycle。
-  不手写 regenerate checkpoint fork。
-  不手写 edit message checkpoint fork。
-  不重复实现 Stop。

assistant-ui 当前 LangChain Runtime 已直接支持 regenerate/edit 的 checkpoint fork，并暴露 Thread loading 和 LangGraph custom state，因此这些逻辑全部从应用代码删除。

## 2.2 删除 App 中聊天生命周期代码

从 `App.tsx` 移除：

```text
useStream(...)
useToolCalls(...)
isSubmittingRef
runError 本地状态机
hydrationError 本地状态机
handleSendMessage
handleRegenerate
handleRetryMessage
handleStopGeneration
消息投影
toolCalls 投影
大部分 thread 生命周期协调代码
```

最终 `App.tsx` 只负责：

```text
AssistantProvider
AppLayout
SettingsDialog
ErrorBoundary
```

目标：

```text
App.tsx < 100~150 行
```

不是为了追求行数，而是禁止它重新承担 Runtime 职责。

------

# P3：彻底重做会话管理

当前：

```text
useThreadNavigation
useThreadDirectory
useAuxiliaryRuns
useThreadActions
Sidebar 内大量 thread 状态逻辑
```

全部逐步删除。

新增唯一适配文件：

```text
src/lib/langgraph/thread-list-adapter.ts
```

只负责把 LangGraph Thread API 映射给 assistant-ui Remote Thread List。

-  `client.threads.search()` → list。
-  Thread create → initialize。
-  Thread metadata title → rename。
-  Thread delete → delete。
-  title generation 继续调用现有后端实现，不在前端建立标题任务状态机。
-  将 `unstable_threadListAdapter` 的使用封装在此文件，不让 unstable API 扩散到 UI。
-  不建立另外一份 `ThreadSession[]` 作为权威状态。
-  不维护 `busyThreadIds`。
-  不通过轮询拼接当前 Thread 与后台 Thread 的运行状态。
-  不自己控制切换 Thread 时的消息恢复。

assistant-ui `ThreadListPrimitive` 已负责新建、选择和 Thread 列表上下文，官方 Thread List 组件还提供 skeleton、菜单、archive/delete 等常见交互。

------

# P4：用官方 Thread Element 替换整个聊天壳

优先安装并使用官方 `Thread` Element。

删除：

```text
components/ChatWindow.tsx
components/chat/ThreadViewport.tsx
components/chat/MessageList.tsx
components/chat/UserMessage.tsx
components/chat/AssistantTurn.tsx
components/chat/Composer.tsx
components/MessageActions.tsx
components/OptimisticMessageStatus.tsx
```

assistant-ui Thread 已经包含：

```text
Message list
Composer
Auto-scroll
Scroll-to-bottom
Welcome
History loading
Running state
Tool fallback
Message actions
```

因此不要将旧组件“套”进 Thread。

官方 Thread Element 本身就是完整聊天 Surface，包含消息列表、Composer、自动滚动以及 welcome/history-loading/running 状态。

## 4.1 保留视觉，不保留实现

只修改官方 Thread Element 的：

```text
宽度
间距
字号
圆角
neutral 色阶
hover 状态
avatar
message spacing
composer shadow
```

保持当前：

```text
白色背景
neutral 灰色
max-w-4xl
轻量边框
低阴影
圆角输入框
正文式 Assistant Message
```

禁止为了“保持旧视觉”复制旧组件业务逻辑。

------

# P5：Composer 完全回归 assistant-ui

删除现有：

```text
inputText
textareaRef
IME composition 手写处理
textarea 自动高度
Enter 发送
Send / Stop 状态切换
runActive disabled
scroll / submit 组合逻辑
```

优先直接使用 Thread Element 已包含的 Composer。

只有确实需要改变布局时，才使用：

```text
ComposerPrimitive.Root
ComposerPrimitive.Input
ComposerPrimitive.Send
ComposerPrimitive.Cancel
```

assistant-ui 官方建议普通聊天界面优先使用 Thread 自带 Composer，只有独立或特殊布局的输入器才直接使用 Composer Primitive。

LMA 自定义内容仅保留：

- placeholder；
- 左侧业务快捷动作；
- Context Usage；
- 样式 className。

------

# P6：Reasoning / Thinking 完全替换

删除：

```text
ThinkingBlock.tsx
ThinkingIndicator.tsx
thinking-block CSS
expanded 状态
active spinner 状态
reasoning lifecycle 判断
```

改用 assistant-ui Reasoning / GroupedParts。

-  Reasoning 默认折叠。
-  流式过程中显示官方 running 状态。
-  完成后显示“已思考”。
-  reasoning + tool calls 可使用 `MessagePrimitive.GroupedParts` 组合成连续调查过程。
-  不展示伪造思考耗时。
-  不通过字符串推断 reasoning 状态。
-  不继续采用已经 deprecated 的旧 ChainOfThought/ReasoningGroup API。

当前 assistant-ui 已建议使用 `MessagePrimitive.GroupedParts` 处理 reasoning/tool-call 分组，而旧的部分 Group API 已进入 deprecated 状态。

------

# P7：Tool Call Shell 全部交给 assistant-ui

删除现有 `InlineToolCall.tsx` 中对通用工具生命周期的维护：

```text
isPending
isError
hasToolMessageResult
hasLiveOutput
isLiveRunning
spinner/check/error icon lifecycle
折叠 Shell
通用 Tool 错误 Shell
```

assistant-ui Tool Call 已提供：

```text
running
complete
incomplete
cancelled
requires-action
error
args
result
timing
```

这些状态不得再次推断。

## 7.1 使用 ToolFallback

安装官方：

```text
@assistant-ui/tool-fallback
```

用于所有没有专门业务 Renderer 的工具。

禁止自己再实现：

```text
GenericToolResult
GenericToolCard
UnknownTool
```

ToolFallback 已经是 Thread 默认未注册工具 Renderer，并自带 collapsible、状态、args、result、error 和 approval 展示。

## 7.2 LMA 工具只保留“结果内容”

保留：

```text
GnssResult
WeatherResult
VisionResult
StationResult
SiteEnvironmentResult
```

但这些组件不得继续负责工具生命周期。

目标结构：

```text
assistant-ui Tool Part
        │
        ├── 通用状态、折叠、error → assistant-ui
        │
        └── result/artifact
                 ↓
          LMA Tool Renderer
```

现有 `ToolMessage.artifact` 可以继续保留。assistant-ui 当前 LangChain message converter 已保留 ToolMessage 的 `result`、`artifact` 和 `isError` 信息，因此本轮无需为了 UI 重构修改大数据/图片的消息存储方案。

## 7.3 精简 Tool Registry

当前 `components/tools/registry.tsx` 重构为：

```text
features/monitoring/tools/
├── registry.ts
├── GnssResult.tsx
├── WeatherResult.tsx
├── VisionResult.tsx
├── StationResult.tsx
└── SiteEnvironmentResult.tsx
```

Registry 只负责：

```text
tool name → business renderer
```

禁止再承担：

```text
工具运行状态
loading
error lifecycle
collapse lifecycle
消息关联
JSON 猜测
```

------

# P8：Markdown 改用 assistant-ui Streamdown

删除：

```text
MarkdownMessage.tsx
react-markdown
remark-gfm
大量 .message-markdown CSS
```

统一改用：

```text
@assistant-ui/react-streamdown
```

只配置当前真正需要的：

```text
普通 Markdown
GFM
表格
代码块
中文排版
```

暂时不要因为组件支持就引入：

```text
Mermaid
数学公式
复杂代码运行器
```

除非后续 LMA 确实需要。

------

# P9：推荐下一步改用 Suggestion / Follow-up Element

当前 `NextActions.tsx` 删除。

LangGraph state 中继续保留：

```text
recommendations
```

前端通过 `useLangChainState` 或极薄的 state bridge 读取，不重新访问原始 stream。

改用 assistant-ui：

```text
SuggestionPrimitive
或 Follow-up Suggestions Element
```

仅最新一轮、且 Run 完成后显示。

点击后直接进入 Composer/Send 流程。

assistant-ui 已提供 starter/follow-up suggestions 对应的 Primitive 和 Element。

------

# P10：Context Usage 使用官方 Context Element

保留后端：

```text
context_usage
```

删除 `ContextUsageIndicator.tsx` 中可以被官方组件替代的：

```text
Tooltip
Popover
Ring/bar 基础结构
通用 hover 行为
```

优先使用 assistant-ui Context Display Element。

LMA 只负责把：

```text
used tokens
limit
percentage
summary state
```

映射过去。

不要在 Composer 里重新设计一套 Context UI。

assistant-ui Elements 已提供 Context Display，用于 ring、bar、text 及 hover 详情。

------

# P11：Sidebar 重构为 ThreadList Element

视觉继续保持当前约 240px 左侧栏。

使用：

```text
ThreadListPrimitive.Root
ThreadListPrimitive.New
ThreadListPrimitive.Items
ThreadListItemPrimitive.Root
ThreadListItemPrimitive.Trigger
ThreadListItemPrimitive.Title
```

可直接从官方 Thread List Element 开始修改样式。

保留 LMA 的：

```text
LMA Monitor Logo
“新建监测会话”中文文案
当前浅灰 active 状态
底部设置入口
折叠 Sidebar
```

删除 Sidebar 内自行维护的：

```text
editingId
delete modal state machine
busyThreadIds
title pending 生命周期
loading 拼接
thread switch lifecycle
手写 item skeleton
```

Rename/Delete 使用 runtime action + shadcn Dialog/Menu。

------

# P12：通用 UI 全量收敛到 shadcn/ui

统一安装并使用需要的官方组件：

```text
Button
Textarea
Dialog
AlertDialog
DropdownMenu
Tooltip
Popover
Collapsible
ScrollArea
Skeleton
Separator
Badge
Sonner
```

对应删除：

```text
Toast.tsx
自定义 modal shell
自定义 alert shell
自定义 dropdown shell
通用 spinner/skeleton 重复组件
通用 tooltip
```

原则：

```text
业务组件可以组合通用 UI
但不得重新实现通用 UI
```

例如：

```text
SiteEnvironmentResult
  └─ shadcn Card / Badge / Collapsible
```

而不是创建：

```text
LmaCard
LmaBadge
LmaCollapse
LmaModal
```

这种只包装 className 的二次组件。

------

# P13：设置页面简化

`ConfigModal.tsx` 重构为：

```text
features/settings/ServiceSettingsDialog.tsx
```

使用：

```text
shadcn Dialog
shadcn Input
shadcn Button
shadcn Alert
sonner
```

保留：

```text
API URL
测试连接
开发环境可配置
生产环境锁定
```

不要再维护自己的 modal header/footer/button 样式体系。

------

# P14：错误处理简化

保留 React 顶层 Error Boundary，用于真正的 React render crash。

除此之外：

-  Runtime Error 使用 assistant-ui Error Primitive。
-  Tool Error 使用 Tool Call status。
-  Thread loading error 使用 Runtime/Thread 状态。
-  Toast 使用 Sonner。
-  不维护另一套 `runError`。
-  不维护另一套 `hydrationError`。
-  不通过错误字符串判断工具状态。
-  不把后端内部异常直接显示给用户。
-  不增加“如果官方状态没回来就猜一个状态”的兜底。

目标是：

```text
错误事实来源只有真正拥有该错误的层
```

------

# P15：整理新的目录结构

目标：

```text
frontend/src/
├── app/
│   ├── App.tsx
│   ├── AppLayout.tsx
│   └── providers/
│       └── AssistantProvider.tsx
│
├── components/
│   ├── assistant-ui/
│   │   └── elements/
│   │       ├── thread.aui.tsx
│   │       ├── thread-list.aui.tsx
│   │       ├── reasoning.aui.tsx
│   │       ├── tool-fallback.aui.tsx
│   │       └── ...
│   │
│   └── ui/
│       └── shadcn generated components
│
├── features/
│   ├── monitoring/
│   │   ├── tools/
│   │   ├── map/
│   │   └── schemas.ts
│   │
│   └── settings/
│       └── ServiceSettingsDialog.tsx
│
├── lib/
│   ├── langgraph/
│   │   ├── client.ts
│   │   └── thread-list-adapter.ts
│   └── utils.ts
│
├── styles/
│   └── globals.css
│
└── main.tsx
```

不要重新建立：

```text
chat/
hooks/thread/
runtime/
message/
stream/
```

等大量项目自有抽象目录，除非 assistant-ui 无法直接解决实际需求。

------

# P16：彻底删除旧代码

完成新 Thread 后一次性删除，而不是长期保留两套实现。

计划删除：

```text
components/ChatWindow.tsx
components/MarkdownMessage.tsx
components/MessageActions.tsx
components/OptimisticMessageStatus.tsx
components/ThinkingBlock.tsx
components/ThinkingIndicator.tsx
components/Toast.tsx

components/chat/AssistantTurn.tsx
components/chat/Composer.tsx
components/chat/MessageList.tsx
components/chat/NextActions.tsx
components/chat/ThreadViewport.tsx
components/chat/UserMessage.tsx
```

完成 Thread List 后删除：

```text
hooks/useThreadNavigation.ts
hooks/useThreadDirectory.ts
hooks/useAuxiliaryRuns.ts
hooks/useThreadActions.ts
```

`RunStatusBar.tsx` 原则上删除，只允许保留 assistant-ui 没有覆盖且确实属于 LMA 业务的信息。

`InlineToolCall.tsx` 删除，其业务 renderer 迁移至 `features/monitoring/tools`。

旧文件不得保留：

```text
Compat
Legacy
FallbackV1
OldChat
OldComposer
```

本轮没有兼容要求，因此禁止通过这些代码降低迁移难度。

------

# P17：CSS 大幅清理

当前 `styles/index.css` 重构。

删除：

```text
手写 Markdown 排版
thinking-block CSS
聊天滚动按钮 CSS
可以由 Tailwind / official element 完成的通用 UI CSS
```

只保留：

```text
LMA design tokens
全局字体
scrollbar 少量统一样式
MapLibre/地图 marker
GNSS/业务图表确实需要的样式
```

目标不是把旧 CSS 原封不动搬到新组件，而是通过 Tailwind token 保留视觉风格。

------

# P18：保持当前产品边界

本轮明确不做：

```text
❌ 三栏布局
❌ Agent 工作台
❌ Canvas
❌ Notebook
❌ Artifact Server
❌ 对象存储
❌ Base64 图片迁移
❌ 大数据引用化
❌ 文件系统
❌ 多 Agent 面板
❌ Workflow 可视化
❌ 调试 Inspector
❌ 前端自行保存一套会话数据库
```

仍保持：

```text
左侧 Thread List
+
中央聊天区
+
内嵌工具业务结果
```

------

# P19：保留并优化现有视觉语言

视觉目标不是变成 assistant-ui Demo，而是让 assistant-ui 使用 LMA 当前风格。

保持：

```text
background: white
neutral / zinc 主色
很浅的 border
低强度 shadow
12~16px 圆角
max-w-4xl 内容宽度
较高正文可读性
工具调用轻量化
Reasoning 默认折叠
用户消息与 AI 消息视觉层级清晰
```

重点调整：

-  Sidebar active 状态降低视觉重量。
-  Composer 与内容区保持现有悬浮感。
-  Tool Call 一行状态不做大型 Card。
-  展开后才显示 GNSS / Weather / Vision 详细结果。
-  长报告保持正文排版，不套多层卡片。
-  空会话提供 3~4 个业务 starter prompts。
-  回复完成后显示最多 3 个 follow-up suggestions。
-  切换会话时不清空整个页面再闪烁加载。
-  后台运行会话在 Sidebar 显示官方 runtime running 状态。
-  移动端 Sidebar 改 Sheet/Drawer，不设计新的移动端架构。

------

# P20：测试重构

不要把测试继续绑定旧内部实现。

删除大量测试：

```text
自己滚动到底部
Composer textarea 高度
自己判断 tool finished
自己判断 optimistic status
自己判断 thinking expanded lifecycle
自己维护 busyThreadIds
旧 ChatWindow props
```

保留/新增真正关键测试：

```text
Runtime 可连接 LangGraph
历史 Thread 正确加载
新建 Thread 正确运行
切换 Thread 后流式状态正确恢复
Stop 正确取消当前 Run
Regenerate 正确产生 branch
Tool result 正确进入业务 Renderer
Tool error 正确展示
空 Tool result 被视为成功
ToolMessage.artifact 图片可正常展示
GNSS 图表正常展示
Weather renderer 正常展示
Vision renderer 正常展示
推荐下一步只作用于当前最新回合
Context usage 正确展示
Thread rename/delete 正确调用 LangGraph API
设置切换 API endpoint 后 Runtime 正确重建
```

优先测试“适配边界”和“LMA 业务 renderer”，不要测试 assistant-ui 自己已经测试的内部行为。

------

# P21：更新项目协作规则

同步修改 `AGENTS.md`。

删除旧规则中与手写 Chat Runtime 强绑定的内容，例如：

```text
前端直接 useStream
useToolCalls 为唯一 tool lifecycle
OptimisticMessageStatus
自有 Tool Call shell
旧 ChatWindow 生命周期
```

改成：

```text
1. assistant-ui Runtime 是前端聊天 UI 的唯一状态入口。
2. LangGraph Thread/Checkpoint 仍是持久历史唯一事实源。
3. 禁止复制 assistant-ui runtime 状态。
4. 禁止创建第二套 Message / ToolCall / Run 状态机。
5. 通用 UI 优先 assistant-ui Element / Primitive 和 shadcn。
6. LMA 自定义组件只处理领域数据展示。
7. unstable assistant-ui API 必须封装在单一 adapter 文件。
8. ToolMessage artifact 继续作为业务展示数据来源。
9. 不为旧前端实现增加兼容代码。
10. 新增手写通用组件前必须证明 assistant-ui/shadcn 当前无法满足。
```

------

# P22：完成条件

本轮重构只有同时满足下面条件才能结束：

-  `App.tsx` 不再直接管理消息、Run、Tool Call 生命周期。
-  `ChatWindow` 等旧聊天框架完全删除。
-  Thread / Composer / Message / ActionBar / ThreadList 使用 assistant-ui。
-  Reasoning 使用 assistant-ui 官方能力。
-  Tool Call 通用状态使用 assistant-ui。
-  未注册 Tool 使用官方 ToolFallback。
-  Markdown 使用 assistant-ui Streamdown。
-  Suggestion 使用 assistant-ui。
-  Context display 优先使用 assistant-ui。
-  Dialog / AlertDialog / Dropdown / Tooltip / Toast 等全部使用 shadcn/Sonner。
-  只剩一个很薄的 LangGraph Thread List Adapter。
-  GNSS / Weather / Vision / Station / Site Environment 作为领域 Renderer 保留。
-  不存在 legacy/compat 双实现。
-  不修改当前 ToolMessage 大数据/图片存储方案。
-  页面仍为当前单侧栏 + 中央聊天设计。
-  `pnpm build` 通过。
-  前端测试通过。
-  后端测试无回归。
-  切换正在生成的 Thread 再返回后可以继续正确显示其状态/内容。
-  Stop、Regenerate、Tool Error、空 Tool Result 均完成实际端到端验证。

------

# 最终目标

重构后的前端自行维护代码应集中在三件事：

```text
LangGraph 服务配置 / 极薄 Thread Adapter
                 +
LMA 专有业务 Tool Renderer
                 +
LMA 品牌与业务视觉样式
```

以下能力不再由项目自行设计和维护：

```text
Chat Runtime
Message lifecycle
Composer
Streaming UI
Optimistic message
Stop
Regenerate
Auto-scroll
Scroll-to-bottom
Thread loading
Thread switching
Message action bar
Tool lifecycle
Reasoning lifecycle
Generic Tool UI
Thread List UI
Markdown streaming
Suggestion UI
Context UI
Toast
Dialog
Dropdown
Tooltip
Skeleton
Collapsible
```

衡量此次改造是否成功的标准不是“新写了多少 assistant-ui 封装组件”，而是：

**删除多少原本不应该由 LMA 自己维护的通用代码。**

如果某个新组件只是给 assistant-ui/shadcn 再包一层 props 和 className，而没有明确 LMA 业务语义，应优先删除这个包装层，直接使用官方组件。