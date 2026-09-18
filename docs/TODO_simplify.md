# LMA 简化重构 TODO

目标：

> 尽量删除应用层状态推断、兼容代码和补丁逻辑。  
> LangChain / LangGraph 已经提供的生命周期、消息、工具、Thread、Run、Streaming 能力直接使用官方实现。  
> LMA 只保留滑坡监测领域本身必须存在的业务逻辑。

核心原则：

**能直接读官方结果，就不要维护状态。  
能根据“事实是否存在”判断，就不要根据多个状态组合推断。  
能删除中间态，就不要增加新的中间态。**

---

## [x] P0-1 简化工具卡完成条件

**实施状态：已完成（2026-09-18）**
- 彻底移除 `liveToolCall.status === 'finished'` 作为完成条件的硬依赖；
- 错误严格只判断官方明确错误：`toolMessage?.status === 'error' || liveToolCall?.status === 'error'`；
- 成功判断“工具结果是否已经返回”：`hasResult = hasToolMessageResult || hasLiveOutput`；
  - output 为 `{}`、`[]`、`""`、`null`、`0`、`false` 均视为成功产出结果；
  - 只要工具成功产生结果即显示 `✓ 工具名称`，状态统一为 `finished`（成功）；未产生结果且无错误时为 `pending`（正在查询…）；
- 删除全部 `finished-but-syncing`、`settling`、`waiting-for-artifact`、`详细结果同步中`、`正在同步结果` 等过渡态，仅保留 `pending`、`finished`、`error` 三态。

当前仍存在：

```ts
liveToolCall.status === 'finished'
```

直接控制 UI 完成状态。

改成：

### 错误

只判断官方明确错误：

```ts
toolMessage?.status === 'error'
||
liveToolCall?.status === 'error'
```

### 成功

判断“工具结果是否已经返回”。

优先：

```ts
ToolMessage
```

实时阶段：

```ts
liveToolCall.output
```

概念上：

```ts
hasResult =
  已收到成功 ToolMessage
  ||
  liveToolCall 已产生 output
```

不要使用：

```ts
if (output)
```

因为以下都是合法结果：

```ts
{}
[]
""
null
0
false
```

只要工具成功返回，就立即：

```text
✓ 工具名称
```

如果结果没有可展示业务字段：

```text
该步骤没有可展示的业务数据
```

如果尚未收到结果：

```text
正在查询…
```

最终只保留三个 UI 状态：

```text
pending
success
error
```

删除：

```text
finished-but-syncing
settling
waiting-for-artifact
详细结果同步中
正在同步结果
工具完成但结果未到
```

---

## [x] P0-2 ToolMessage 与 live output 只作为两个时间阶段，不作为两套状态

**实施状态：已完成（2026-09-18）**
- 数据源统一收口：优先消费持久化的 `ToolMessage.artifact.data`（或 `artifact`），未到达前消费 `liveToolCall.output`；
- `ToolMessage` 到达后自然无缝替换 `live output`，不设立中间比较机制，不维护状态机，各工具独立返回、独立展示。

正确模型：

```text
工具执行
   ↓
liveToolCall.output
   ↓
立即展示
   ↓
ToolMessage.artifact
   ↓
最终持久化结果覆盖实时结果
```

不是：

```text
live status
   ↓
finished
   ↓
等待 ToolMessage
   ↓
再次 finished
```

前端数据源：

```ts
const displayResult =
  toolMessage?.artifact ??
  liveToolCall?.output;
```

ToolMessage 到达后自然替换 live output。

不要：

- 比较两个结果是否一致；
- 建立 liveResult / persistedResult 状态机；
- 增加 synchronization 状态；
- 增加 timer；
- 等所有并行工具完成。

每个工具独立返回、独立完成、独立展示。

---

## [x] P0-3 工具空结果视为正常结果

**实施状态：已完成（2026-09-18）**
- 统一语义：`success + data`、`success + empty`、`error` 严格区分；
- 空对象 `{}`、空数组 `[]`、`null` 等空结果均被视为合法成功输出，展开时展示“该步骤没有可展示的业务数据”，绝不回退至 `pending/loading` 或转为 `error`。

统一业务语义：

```text
工具调用成功
≠
一定存在业务数据
```

例如：

```text
监测点列表为空
天气记录为空
时间范围内 GNSS 为空
地质服务返回空集合
附近没有断层记录
```

都可能是成功调用。

因此：

```text
success + data
success + empty
error
```

严格区分。

不要把：

```text
empty
```

转换成：

```text
error
loading
retry
```

除非上游 API 本身明确返回错误。

---

## [x] P0-4 删除 Tool UI 中不必要的 JSON 猜测

**实施状态：已完成（2026-09-18）**
- 顶层提取统一函数 `parseOutputRecord(output: unknown): Record<string, any> | undefined`；
- 禁止在各个 Tool 卡片/表格渲染函数中分别使用 `typeof === 'string'`、`startsWith('{')` 或重复 `JSON.parse`；
- 非合法 JSON 结构安全返回 `undefined` 并由两阶段数据源平滑回退。

当前前端仍会：

```ts
typeof liveOutput === 'string'
JSON.parse(liveOutput)
```

检查是否可以进一步简化。

优先让后端 Tool 的返回协议保证：

```text
liveToolCall.output
```

本身就是稳定结构。

如果官方 `content_and_artifact` 流式投影能够直接提供结构化 output，则前端不要再：

```ts
startsWith('{')
try JSON.parse
catch
```

目标：

```ts
const liveData = isRecord(liveToolCall?.output)
  ? liveToolCall.output
  : undefined;
```

如果确实存在官方 SDK 将 output 序列化成字符串的情况，再保留一个集中转换函数。

禁止在每个 Tool renderer 里分别解析。

---

## P0-5 InlineToolCall 只负责展示，不负责恢复协议状态

`InlineToolCall` 最终只做：

```text
拿 toolCall
拿 live result
拿 final ToolMessage
选择结果
渲染
```

不要负责：

- 推断 Run 生命周期；
- 判断其他工具有没有结束；
- 等待 checkpoint；
- 判断 Agent 是否准备再次调用模型；
- 推断“正在整理回答”；
- 处理 Run stop；
- 处理 reconnect。

---

# P0-6 删除前端 Stop 后的 checkpoint 修复责任

目前：

```text
stop
→ getState
→ 扫描 AIMessage.tool_calls
→ RemoveMessage
→ updateState
→ hydrate
```

这是目前前端最大的补丁逻辑。

优先重新验证当前最新版官方行为。

因为当前 `@langchain/react 1.1.0` 已经采用新的 v2-native streaming，官方提供自动 re-attach，LangGraph SDK 也将 thread-centric stream 作为推荐实现。

目标：

```ts
await stream.stop({ cancel: true });
```

结束。

然后官方 Thread state 自己成为最终事实来源。

如果取消工具时当前 LangGraph Server 确实仍会留下无法继续运行的 dangling tool call：

**修复应放后端，而不是浏览器。**

前端不得长期保留：

```ts
getIncompleteToolCallMessageUpdates
removeIncompleteToolCallMessages
RemoveMessage
AIMessage reconstruction
threads.updateState(...)
```

这些都是 Agent runtime 内部知识。

---

## P0-7 删除 STREAM_CONTROLLER 私有 API

当前：

```ts
(stream as any)[STREAM_CONTROLLER]
controller.hydrate(...)
```

属于典型补丁。

当前官方 React SDK 已经支持：

- Thread hydration；
- automatic re-attach；
- remount reconnect；
- root projections。

优先验证公开 API 能否覆盖当前需求。

目标删除：

```text
frontend/src/services/streamCompat.ts
```

特别是不再使用：

```ts
STREAM_CONTROLLER
```

如果当前公开 API 仍缺一个主动 refresh：

不要继续围绕私有 API 写更多逻辑。

短期只将兼容调用限制在这一个文件中，等待官方公开能力。

---

# P0-8 不再新增任何前端消息状态模型

继续坚持最近提交已经采用的方向。

唯一消息来源：

```ts
stream.messages
```

唯一工具来源：

```ts
useToolCalls(stream)
```

唯一运行状态：

```ts
stream.isLoading
```

唯一 hydration：

```ts
stream.isThreadLoading
```

唯一 optimistic 状态：

```ts
useMessageMetadata(...)
```

禁止新增：

```text
MessageState
ToolState
RunPhase
StreamingPhase
SettlingState
ToolSyncState
ConversationLifecycle
```

除非官方 API 根本没有对应事实。

---

# P0-9 前端不要根据多个官方字段重新发明“综合状态”

典型错误：

```ts
if (
  stream.isLoading &&
  tool.status === finished &&
  !toolMessage &&
  !artifact &&
  ...
)
```

这种判断会越来越复杂。

原则改为：

### Chat

```ts
stream.isLoading
```

### Tool

```text
error?
result returned?
otherwise pending
```

### Message

```ts
BaseMessage
```

### Thread

```ts
Agent Server Thread
```

每个 UI 只消费它真正关心的一个事实。

---

# P0-10 删除多余的“防御性 fallback”

逐个搜索：

```text
fallback
compat
legacy
guess
infer
syncing
settling
reconcile
hydrate
workaround
```

逐项判断：

1. 官方现在是否已经支持；
2. 是否还真实发生；
3. 是否只是过去 bug 遗留。

可以删除就直接删除。

尤其避免：

```text
A失败 → 尝试B
B失败 → 猜C
C不存在 → 构造D
```

推荐：

```text
官方数据存在 → 使用
不存在 → 不显示 / 明确 unavailable
```

---

# P1-1 保持 create_agent，不再增加 Agent Graph 节点

主 Agent 当前：

```python
create_agent(...)
```

已经足够。

不要重新加入：

```text
intent node
planner node
tool router node
analysis node
final node
```

除非业务上存在真正确定性的流程要求。

现在 LMA 本质仍是 Tool-Using Agent。

让：

```text
LLM
→ tools
→ LLM
```

继续由官方 `create_agent` 管理。

---

# P1-2 Middleware 继续做减法

目前官方已经有：

```text
SummarizationMiddleware
ModelRetryMiddleware
ToolRetryMiddleware
ModelCallLimitMiddleware
ToolCallLimitMiddleware
```

继续检查自定义 `LmaMiddleware`。

只保留 LMA 必须做的事情。

例如可以保留：

```text
业务时间 metadata
context usage 展示
业务 Tool error artifact
```

能交给官方的：

```text
retry
tool lifecycle
call limit
generic error conversion
```

全部交给官方。

不要写：

```text
RetryMiddleware 的外层 Retry
ToolMiddleware 的外层 ToolNode
SummarizationMiddleware 的外层 summary manager
```

---

# P1-3 ToolErrorMiddleware 能覆盖的逻辑直接采用官方

检查当前 LangChain `ToolErrorMiddleware`。

如果已经可以覆盖：

```text
普通异常
参数错误
安全错误文案
```

则 `LmaMiddleware.awrap_tool_call()` 继续缩小。

最终自定义部分只负责：

```text
LMA 领域错误
artifact
partial evidence
```

而不是重新实现完整 Tool exception framework。

---

# P1-4 模型 Provider adapter 只保留一个已证明必要的例外

当前：

```text
init_chat_model
```

作为统一入口是正确方向。

DeepSeek 的：

```python
DeepSeekThinkingChatModel
_get_request_payload
```

属于唯一特殊例外。

继续保持：

```text
一个文件
一个类
一个目的
一个 upstream 删除条件
```

不要扩展成：

```text
Provider abstraction framework
Capability adapter framework
Message normalization framework
```

如果新版官方 `ChatDeepSeek` 修复 reasoning_content tool-loop 回传：

直接删掉整个 adapter。

---

# P1-5 Structured Output 继续完全使用官方实现

最近视觉模型从：

```text
正则
JSON 提取
json.loads
格式修复
```

改到：

```python
with_structured_output(...)
```

这是正确范例。

同样处理：

- recommendation；
- vision observation；
- 后续任何结构化 LLM 输出。

原则：

```text
Pydantic Schema
+
with_structured_output
```

不要重新出现：

```text
extract_json()
repair_json()
strip_markdown_json()
regex_json()
```

---

# P1-6 简化会话标题

标题本身不是核心业务。

保持：

```text
首次 Run 创建
→ 异步标题
→ metadata update
```

但不要围绕标题继续增加复杂状态。

UI 最多：

```text
pending
title
新会话
```

失败：

```text
新会话
```

结束。

不要 retry state、error card、title recovery state machine。

---

# P1-7 下一步推荐也保持非核心能力

推荐失败：

```ts
[]
```

即可。

不要：

- 推荐错误卡；
- 推荐 retry；
- 推荐 checkpoint；
- 推荐历史状态；
- 推荐恢复机制。

其生命周期只绑定：

```text
当前 final AIMessage
```

切换会话或下一轮：

```text
直接丢弃
```

---

# P1-8 会话列表减少轮询逻辑

当前 busy Thread 每 3 秒：

```text
getBusySessions
```

可以暂时保留。

但不要继续增加：

```text
busy reconciliation
busy timeout
busy stale detector
busy local heartbeat
```

后续如果官方 Thread Streaming / lifecycle projection 可以直接覆盖 sidebar busy 状态，再删除轮询。

在官方能力成熟前：

```text
一个 3 秒轻量轮询
```

比建立复杂事件同步系统更简单。

---

# P1-9 App.tsx 只做“拆文件”，不要引入新的状态框架

`App.tsx` 当前偏大。

可以拆：

```text
useThreadList
useConversation
useAuxiliaryRuns
```

但不要因为代码长就马上加入：

```text
Redux
Zustand
XState
复杂 Context
Event Bus
```

官方 `useStream` 本身已经是主要 conversation state manager。

拆文件的目的只是可读性，不是重新管理状态。

---

# P1-10 工具 renderer 按“结果类型”拆，而不是按生命周期拆

当前 `InlineToolCall.tsx` 非常大。

适合：

```text
InlineToolCall
  ↓
choose data
  ↓
ToolResultRenderer
```

再按业务内容：

```text
StationListResult
GnssResult
WeatherResult
VisionResult
SiteEnvironmentResult
```

不要拆：

```text
PendingTool
FinishedTool
LiveFinishedTool
PersistedTool
SettlingTool
```

生命周期只有：

```text
pending / success / error
```

具体 renderer 只处理数据。

---

# P1-11 Tool artifact 协议只解决结构，不解决生命周期

可以统一：

```ts
artifact.data
artifact.images
artifact.chart_points
artifact.site_environment
artifact.error
```

但不要设计：

```text
artifact.phase
artifact.sync_status
artifact.lifecycle
artifact.stream_status
```

这些由官方 Tool streaming 管理。

Artifact 只是：

> 工具已经返回了什么业务结果。

---

# P1-12 上游 API 层也遵守同样原则

Beidou / Weather / DEM / Geology：

尽量直接：

```text
官方 HTTP client
→ schema
→ domain data
```

避免：

```text
多层 fallback
自动猜字段
默认坐标
备用 URL
备用假数据
隐式纠错
```

错误就明确错误。

缺数据就明确缺数据。

部分成功就返回部分成功。

---

# P2-1 真正需要增加的是测试，而不是运行时代码

对于每一次“简化”，优先补一个测试证明可以删除代码。

例如工具：

```text
running + 无 output
→ loading

output = {}
→ success

output = []
→ success

output = null
→ success

output = 正常对象
→ success + 内容

ToolMessage 后到
→ artifact 覆盖 live output

error
→ error

并行 A/B/C
→ 谁返回谁完成
```

不需要模拟：

```text
finished-but-not-synced
settling
wait-for-artifact
```

因为这些状态不应该再存在。

---

# P2-2 加一组“禁止重新造轮子”的测试/规则

代码审查重点搜索：

```text
STREAM_CONTROLLER
RemoveMessage
updateState
JSON.parse(model output)
custom retry loop
custom tool lifecycle
custom message lifecycle
custom SSE parser
```

每新增一个都必须说明：

> 为什么官方方案无法完成？

没有明确理由就不引入。

---

# 最终希望形成的前端模型

## Assistant

```text
stream.messages
```

## Run

```text
stream.isLoading
```

## Tool

```text
error
↓
result returned
↓
pending
```

## Tool data

```text
ToolMessage.artifact
    ↓ fallback
liveToolCall.output
```

## Thread

```text
Agent Server
```

## Reasoning

```text
AIMessage.contentBlocks
```

## Retry / summary / call limit

```text
LangChain Middleware
```

除此之外，不再额外维护一套 LMA Runtime 状态机。

---

# 实施优先级

第一批只做减法：

1. 工具完成条件改为“结果已返回”，不直接使用 `liveToolCall.status === finished` 控制完成 UI。
2. 空 output 明确作为成功结果。
3. 删除工具“同步中”等所有中间态。
4. 检查能否删除 live output 字符串 JSON 猜测。
5. 验证并删除前端 Stop checkpoint 修补。
6. 删除 `STREAM_CONTROLLER` 私有 hydrate。
7. 进一步缩小 `LmaMiddleware`。
8. 所有删除行为补最小测试。

第二批再整理代码：

9. 拆 `InlineToolCall` 的业务 renderer。
10. 拆 `App.tsx`，但不引入新状态管理框架。
11. 整理后端 domain / integrations / tools 边界。
12. 大 artifact 移出 checkpoint。

暂时不要新增：

- 多 Agent；
- Planner；
- 自定义 Event Bus；
- 自定义 SSE；
- Redux/XState；
- 自定义 Tool lifecycle；
- 自定义 Message 模型；
- 自定义 Retry framework；
- 自定义 Summarization；
- 为边缘情况增加新的中间状态。