# LMA Frontend V2 重构方案（assistant-ui 版）

> 项目：`C-jcbest/LMA`
> 分支基线：`codex/complete-todo`
> 目标：不兼容现有前端实现，直接重构为 Frontend V2。
> 约束：
> 1. LangGraph 继续作为唯一 Agent Runtime；
> 2. 使用 assistant-ui 尽可能替换全部通用 Chat UI；
> 3. 保留当前基本视觉风格；
> 4. 当前阶段消息仍可直接携带大数据和 Base64 图片；
> 5. 当前阶段不设计 Artifact 工作台 / 三栏工作台；
> 6. 当前阶段仍以“Sidebar + Chat”作为主布局；
> 7. 不为旧前端保留兼容代码。

---

# 1. 最终目标

本次不再做“旧前端迁移”，而是直接重建：

```text
LMA Frontend V2
```

目标架构：

```text
                   LangGraph Server
                          │
                          ▼
                  @langchain/react
                      useStream
                          │
                          ▼
         @assistant-ui/react-langchain
                    useStreamRuntime
                          │
                          ▼
              AssistantRuntimeProvider
                          │
          ┌───────────────┴───────────────┐
          │                               │
     assistant-ui                     shadcn/ui
          │                               │
        Thread                         Button
        Message                        Dialog
        Composer                       Tooltip
        Reasoning                      Sheet
        Tool                           Alert
        ActionBar                      Badge
        Interrupt                      Skeleton
        Attachment                     Sonner
          │
          ▼
      LMA Domain UI
          │
       GNSS
       Weather
       Station
       Vision
       Site Environment
       Map
```

核心原则：

> **LangGraph 负责运行时，assistant-ui 负责 Chat UX，shadcn/Radix 负责通用 UI，LMA 只维护领域展示。**

---

# 2. 不再坚持自写 `useExternalStoreRuntime`

如果不需要兼容旧前端，首选：

```text
@assistant-ui/react-langchain
useStreamRuntime
```

而不是：

```text
useStream
+
自己 useExternalStoreRuntime
```

原因：

`useStreamRuntime` 已经建立在：

```text
@langchain/react/useStream
+
assistant-ui ExternalStoreRuntime
```

之上。

可以直接复用现成能力：

- LangChain Message 转换；
- Tool Call 映射；
- Regenerate；
- Edit；
- Checkpoint；
- Interrupt；
- Respond；
- Error；
- Thread hydration；
- Custom Graph State；
- Subagent / Subgraph。

只有出现明确无法满足的 LMA Runtime 需求时，才降级到：

```text
useExternalStoreRuntime
```

不要把 Runtime Adapter 再做成新的长期维护模块。

---

# 3. 技术栈一次升级

Frontend V2 直接采用新技术栈。

```text
Node.js 20+
pnpm

React 19
React DOM 19

Vite 8
TypeScript strict

Tailwind CSS 4
shadcn/ui
Radix flavor

@assistant-ui/react
@assistant-ui/react-langchain
@assistant-ui/react-markdown

@langchain/react
@langchain/langgraph-sdk
@langchain/core

React Router
TanStack Query
Zod

Lucide
Sonner
MapLibre

Vitest
Testing Library
MSW
Playwright
axe
```

## 不做

- 不迁 Next.js；
- 不引入 AI SDK `useChat`；
- 不保留 React 18 compatibility；
- 不保留 Tailwind 3 compatibility；
- 不继续兼容旧 CSS class；
- 不保留旧 Chat primitives。

---

# 4. 新项目目录

```text
frontend/src/

app/
  App.tsx
  router.tsx
  providers.tsx
  queryClient.ts
  config.ts

agent/
  runtime.tsx
  state.ts
  toolkit.tsx
  interrupts.tsx
  errors.ts

features/
  chat/
    ChatPage.tsx
    ChatHeader.tsx
    RunStatusBar.tsx
    Recommendations.tsx

  threads/
    ThreadSidebar.tsx
    threadQueries.ts
    threadMutations.ts

  monitoring/
    GnssResultView.tsx
    WeatherResultView.tsx
    StationResultView.tsx
    VisionResultView.tsx
    SiteEnvironmentView.tsx
    MonitoringMap.tsx

components/
  assistant-ui/
    thread.aui.tsx
    reasoning.aui.tsx
    markdown-text.aui.tsx
    tool-fallback.aui.tsx
    tool-group.aui.tsx
    attachment.aui.tsx

  ui/
    button.tsx
    input.tsx
    textarea.tsx
    dialog.tsx
    alert-dialog.tsx
    dropdown-menu.tsx
    popover.tsx
    tooltip.tsx
    sheet.tsx
    alert.tsx
    badge.tsx
    skeleton.tsx
    progress.tsx
    scroll-area.tsx

lib/
  langgraph.ts
  datetime.ts
  errors.ts

styles/
  globals.css
```

---

# 5. 主页面暂时保持双栏结构

本阶段不设计 Artifact 工作台。

桌面继续：

```text
┌──────────────────┬──────────────────────────────────────┐
│ Thread Sidebar   │ Chat                                 │
│                  │                                      │
│ 历史会话          │ assistant-ui Thread                  │
│                  │                                      │
│                  │ Tool / Image / Chart 直接在消息中展示 │
│                  │                                      │
│                  │ Composer                             │
└──────────────────┴──────────────────────────────────────┘
```

移动端：

```text
Sidebar
→ shadcn Sheet

Chat
→ 全宽
```

不做：

```text
右侧 Artifact Panel
三栏工作台
独立 Evidence workspace
```

以后需要时再作为独立阶段增加。

---

# 6. 消息继续允许携带大数据和图片

本阶段明确允许：

```text
ToolMessage
├─ text
├─ structured data
├─ chart_points
├─ images
└─ base64 image
```

不要求现在改成：

```text
artifact_id
signed URL
object storage
```

因此已有：

```text
png_base64
images
chart_points
site_environment
```

可以继续。

## 需要做的限制

虽然暂不改变数据协议，但前端仍需要避免页面被拖垮。

### 6.1 图片

- [ ] Base64 图片使用 lazy rendering；
- [ ] 不可见图片不提前解码；
- [ ] 设置最大显示宽度；
- [ ] 点击可放大 Dialog；
- [ ] 超大图片避免一次重复创建多个 `<img>`；
- [ ] 历史 Thread hydration 时不做额外复制。

### 6.2 大时序数据

- [ ] Chart renderer 使用 memo；
- [ ] 大数组不再 spread 多次；
- [ ] Tool Message 转换过程中只引用原对象；
- [ ] 不把同一份数据复制进 assistant-ui local state；
- [ ] 图表只在 Tool 展开或进入视口后初始化（可选）；
- [ ] 不 stringify 大型数据用于 debug UI。

### 6.3 消息 Runtime

必须：

```text
LangGraph message
      ↓
assistant-ui projection
```

不要：

```text
LangGraph 大消息
      ↓
copy
      ↓
React state
      ↓
copy
      ↓
assistant-ui state
```

避免大数据内存翻倍。

---

# 7. Runtime

采用：

```tsx
useStreamRuntime<LmaState>({
  assistantId,
  apiUrl,
  threadId,
})
```

外层：

```tsx
<AssistantRuntimeProvider runtime={runtime}>
  <ChatPage />
</AssistantRuntimeProvider>
```

LangGraph State：

```ts
interface LmaState {
  messages: BaseMessage[];
  recommendations?: string[];
  context_usage?: ContextUsage;
  runtime_status?: RuntimeStatus;
}
```

Custom State 直接通过 LangChain runtime hook 读取。

例如：

```text
recommendations
context_usage
runtime_status
```

不塞进普通 Message。

---

# 8. URL 与 Thread

重新设计 URL：

```text
/chat
/chat/:threadId
```

使用 React Router。

唯一 Thread ID 来源：

```text
URL
 ↓
threadId
 ↓
useStreamRuntime
```

删除旧：

```text
useThreadNavigation
selectedThreadRef
window.history
popstate
手写 push/replace
```

---

# 9. Thread Directory

Thread list 不强行交给 assistant-ui。

使用：

```text
TanStack Query
```

负责：

```text
Thread search
Thread pagination
Thread rename
Thread delete
Thread metadata
busy status
```

结构：

```text
useInfiniteQuery
→ Thread list

useMutation
→ rename

useMutation
→ delete
```

禁止 Query 保存：

```text
stream.messages
```

职责分离：

```text
TanStack Query
→ Thread resource state

assistant-ui + useStream
→ 当前 Thread realtime state
```

---

# 10. assistant-ui 全面替换范围

本阶段目标是尽可能移除手写 Chat UI。

## 10.1 Thread

删除：

```text
ThreadViewport.tsx
MessageList.tsx
```

使用：

```text
ThreadPrimitive.Root
ThreadPrimitive.Viewport
ThreadPrimitive.Messages
ThreadPrimitive.ScrollToBottom
```

自动滚动、Pinned、Scroll-to-bottom 不再自己写。

---

# 11. Message

删除：

```text
UserMessage.tsx
AssistantTurn.tsx
```

使用 assistant-ui：

```text
MessagePrimitive.Root
MessagePrimitive.Content
```

消息内容继续支持：

```text
text
reasoning
tool
image
```

---

# 12. Markdown

删除：

```text
MarkdownMessage.tsx
```

使用：

```text
@assistant-ui/react-markdown
```

保留：

- GFM；
- 表格；
- Code block；
- Link；
- Copy；
- 横向滚动。

长表格当前仍放消息中，不迁 Artifact Panel。

---

# 13. Composer

删除：

```text
Composer.tsx
```

使用：

```text
ComposerPrimitive.Root
ComposerPrimitive.Input
ComposerPrimitive.Send
ComposerPrimitive.Cancel
```

发送继续由 LangGraph runtime 处理。

保留：

```text
快捷调查问题
Context Usage
未来 Attachment
```

但以 assistant-ui/shadcn 组件组合。

---

# 14. Reasoning

删除：

```text
ThinkingBlock.tsx
```

使用 assistant-ui Reasoning。

LMA 行为：

```text
默认折叠
streaming 不强制展开
finished 保持折叠
```

用户主动展开。

---

# 15. Message Actions

删除：

```text
MessageActions.tsx
```

使用：

```text
ActionBarPrimitive.Copy
ActionBarPrimitive.Reload
ActionBarPrimitive.Edit
```

如果 Edit 早期不稳定：

```text
先关闭 Edit
只开放 Copy / Regenerate
```

不为旧逻辑做 compatibility。

---

# 16. Tool UI

删除：

```text
InlineToolCall.tsx
```

assistant-ui 负责：

```text
Tool Shell
Tool Status
Expand / Collapse
Arguments
Running
Success
Error
```

LMA 负责：

```text
Tool Result Renderer
```

最终：

```text
assistant-ui Tool
       ↓
LMA Toolkit
       ↓
GnssResultView
WeatherResultView
StationResultView
VisionResultView
SiteEnvironmentView
```

---

# 17. Tool Registry

集中：

```text
src/agent/toolkit.tsx
```

示意：

```ts
const tools = {
  get_daily_gnss_data: GnssResultView,
  query_weather: WeatherResultView,
  list_stations: StationResultView,
  visual_review: VisionResultView,
  site_environment: SiteEnvironmentView,
};
```

Tool 都是：

```text
backend/render-only
```

前端不执行 Python Tool。

不要开启：

```text
unstable_enableToolInvocations
```

---

# 18. Tool 数据协议暂时保持现状

因为当前明确不改“大数据和图片在 Message 中”的方式，所以不强制重构成 Artifact API。

但前端 adapter 只允许一个地方理解现有协议。

新增：

```text
src/agent/toolResultAdapter.ts
```

将：

```text
ToolMessage
chart_points
images
png_base64
site_environment
```

统一转换为：

```text
LmaToolViewModel
```

例如：

```ts
type LmaToolViewModel =
  | GnssViewModel
  | WeatherViewModel
  | StationViewModel
  | VisionViewModel
  | SiteEnvironmentViewModel;
```

Renderer 不再自己反复猜 ToolMessage 字段。

这样即使后面协议变化，也只改 adapter。

---

# 19. 不强推新的 Artifact 协议

本阶段不要求：

```text
artifact_id
Evidence Registry
独立 Artifact Store
```

现有 Tool artifact 可以继续。

但建议最低限度统一：

```ts
type ToolArtifactEnvelope<T = unknown> = {
  version: 1;
  kind: string;
  status: "success" | "partial" | "error";
  data?: T;
  error?: {
    code?: string;
    message: string;
  };
};
```

目的只是：

```text
减少 renderer heuristic
```

而不是改变存储方式。

---

# 20. Interrupt

从第一版 Frontend V2 就接好。

LangGraph：

```text
interrupt
 ↓
assistant-ui
 ↓
用户选择
 ↓
respond
```

建立 LMA Interrupt Registry：

```text
station_selection
time_range
confirmation
free_text
```

使用 assistant-ui + shadcn：

```text
Button
RadioGroup
Select
Dialog
Alert
```

---

# 21. Recommendations

继续使用：

```text
stream state recommendations
```

显示为：

```text
assistant-ui suggestion / shadcn button
```

不写成 Assistant Message。

只显示最新一轮 recommendation。

---

# 22. Context Usage

继续属于 runtime state。

位置：

```text
Composer 附近
或 RunStatusBar
```

默认弱化。

达到高使用率时再突出。

---

# 23. Run Status Bar

保留 LMA 自定义能力，但重新实现。

使用：

```text
shadcn Badge
Alert
Progress
Tooltip
```

显示：

```text
当前阶段
当前 Tool
工具调用数量
Context Usage
等待用户
连接状态
```

状态必须来自：

```text
LangGraph State
useStream
```

不通过前端猜。

---

# 24. Connection Status

重新设计：

```text
connected
reconnecting
recovered
unavailable
auth_error
```

显示位置：

```text
ChatHeader
```

原则：

- 正常状态尽量不显示；
- reconnecting 显示轻量状态；
- recovered 短暂提示；
- unavailable 显示 Alert；
- auth error 给明确重新认证提示。

---

# 25. Error

统一：

```ts
type AppError = {
  scope:
    | "run"
    | "thread"
    | "tool"
    | "connection";

  code: string;
  message: string;
  retryable: boolean;
};
```

展示：

```text
Tool
→ Tool 内

Run
→ Conversation 内

Thread CRUD
→ Sonner

Connection
→ Header / Alert

Unexpected Render
→ ErrorBoundary
```

删除：

```text
runError boolean
hydrationError boolean
各种重复 string error
```

---

# 26. Sidebar

视觉仍保留当前：

```text
260px
浅灰背景
Logo
新建会话
Thread list
底部系统菜单
```

但所有基础控件换 shadcn：

```text
Button
Input
DropdownMenu
AlertDialog
Tooltip
Skeleton
ScrollArea
Sheet
```

不再：

```text
<button className="...">
<input className="...">
```

到处重复实现。

移动端：

```text
Sidebar → Sheet
```

---

# 27. ConfigModal

生产环境不再提供：

```text
LangGraph API URL
```

生产：

```text
Browser
 ↓
same-origin endpoint
 ↓
LangGraph
```

开发环境：

```text
.env.local
```

如果需要 GUI 修改开发配置：

```text
DevSettings
```

不要放在普通用户 Sidebar。

---

# 28. 页面视觉保持

本次是底层重写，不是 UI redesign。

继续保持：

```text
白色主背景
浅灰 Sidebar
Neutral 灰阶
Indigo 主操作色
用户浅灰气泡
Assistant 回复弱容器感
Tool 低饱和
Warning Amber
Error Red
大圆角
轻阴影
较宽松正文
```

---

# 29. Design Tokens

Tailwind 4 后统一：

```text
background
foreground
surface
surface-muted
muted
muted-foreground
border
primary
primary-foreground
warning
destructive
success
agent-active
```

不再散落：

```text
#fafafa
neutral-700
indigo-600
```

业务组件优先使用 semantic token。

---

# 30. 暗色模式

既然重建 Design System，可以顺便支持：

```text
system
light
dark
```

但第一版可以：

```text
默认只暴露 light
```

Dark token 先准备好。

---

# 31. Loading 统一

规则：

```text
Skeleton
→ 页面/Thread 初次加载

Spinner
→ 短操作

Tool status
→ Tool 正在执行

Progress
→ 有真实阶段/比例

Thread busy
→ Sidebar activity
```

不再每个组件单独设计 loading。

---

# 32. Toast

删除：

```text
Toast.tsx
useToast()
ToastContainer
```

全部：

```text
Sonner
```

Toast 只处理：

```text
rename success/fail
delete fail
copy success
短暂全局反馈
```

Run/Tool 错误不使用 Toast 替代上下文错误。

---

# 33. 旧代码清理

Frontend V2 完成后直接删除：

```text
ChatWindow.tsx
ThreadViewport.tsx
MessageList.tsx
UserMessage.tsx
AssistantTurn.tsx
ThinkingBlock.tsx
MessageActions.tsx
Composer.tsx
MarkdownMessage.tsx
InlineToolCall.tsx
Toast.tsx
旧 Context UI wrappers
旧手写 Dialog/Popover/Menu
```

旧 Hook 删除或重写：

```text
useThreadNavigation
useAuxiliaryRuns
复杂 title refs
多余 currentClientRef
旧 compatibility refs
```

---

# 34. 标题生成

彻底删除前端标题任务。

后端：

```text
第一次消息
 ↓
异步生成标题
 ↓
更新 thread.metadata.name
```

主 Agent Run 不等待标题完成。

前端：

```text
新监测会话
→ query refresh 后自动出现新标题
```

---

# 35. 不设计工作台带来的 UI 策略

因为当前所有图表、图片、大数据仍在 Message 内，必须控制 Chat 页面膨胀。

## Tool 默认折叠

Tool 完成后默认显示：

```text
✓ 已获取 SCWM-04 GNSS 数据
  [展开结果]
```

用户展开后：

```text
完整图表
图片
表格
```

这样不会每次自动把所有大内容展开。

## 图片

```text
缩略显示
点击放大 Dialog
```

## 长表格

```text
最大高度
ScrollArea
```

## 图表

```text
合理最大高度
允许全屏 Dialog
```

这样在不做 Artifact Panel 的情况下仍能保持对话可用。

---

# 36. 性能要求

因为大数据继续放 Message，Frontend V2 必须特别关注：

- [ ] `React.memo` 用于 Tool result renderer；
- [ ] Tool renderer key 稳定；
- [ ] 大型 arrays 不做深拷贝；
- [ ] message conversion 缓存；
- [ ] Markdown 与 Chart 不因 unrelated stream token 重渲染；
- [ ] Base64 图片 lazy decode；
- [ ] Tool 折叠时不初始化重型图表；
- [ ] Map dynamic import；
- [ ] 历史 Thread hydration 不 duplicate payload；
- [ ] 不在 console 输出大型 Tool result；
- [ ] 避免 `JSON.stringify` 全量 Tool payload；
- [ ] 必要时虚拟化超长 Thread（后续）。

---

# 37. 测试

## Runtime

- [ ] 新会话；
- [ ] optimistic message；
- [ ] stream；
- [ ] Stop；
- [ ] Regenerate；
- [ ] Edit；
- [ ] reconnect；
- [ ] Thread switch；
- [ ] hydration；
- [ ] Interrupt。

## Tool

- [ ] Tool running；
- [ ] Tool 分批完成；
- [ ] Tool error；
- [ ] Tool empty success；
- [ ] GNSS 大数组；
- [ ] Base64 image；
- [ ] 多图；
- [ ] Weather；
- [ ] Map。

## UI

- [ ] Composer；
- [ ] Markdown；
- [ ] Reasoning；
- [ ] Sidebar；
- [ ] Dialog；
- [ ] Tooltip；
- [ ] Mobile Sheet；
- [ ] Image preview；
- [ ] Long Tool result。

## E2E

Playwright：

- [ ] 创建会话；
- [ ] 发送消息；
- [ ] Tool 实时更新；
- [ ] Thread 切换；
- [ ] 返回原 Thread 恢复；
- [ ] Stop；
- [ ] Regenerate；
- [ ] 删除；
- [ ] 重命名；
- [ ] Interrupt；
- [ ] mobile；
- [ ] disconnect/reconnect。

---

# 38. 视觉回归

建立 screenshot baseline。

至少：

```text
Empty Chat
User Message
Assistant Message
Reasoning
Tool Running
Tool Completed
Large GNSS Chart
Image Result
Sidebar
Delete Dialog
Composer
Run Error
Mobile
```

目标：

> 底层完全重构后，用户仍然认为这是原来的 LMA 风格。

---

# 39. 实施顺序

## Phase 0：冻结旧前端

- [ ] 不再继续修旧 Chat UI；
- [ ] 保存视觉截图；
- [ ] 保存业务 Renderer；
- [ ] 保存测试场景。

---

## Phase 1：创建 Frontend V2

- [ ] React 19；
- [ ] Vite 8；
- [ ] Tailwind 4；
- [ ] shadcn；
- [ ] assistant-ui；
- [ ] Router；
- [ ] Query；
- [ ] Test 基础设施。

---

## Phase 2：LangGraph Runtime

- [ ] `useStreamRuntime`；
- [ ] AssistantRuntimeProvider；
- [ ] Thread ID 从 Router；
- [ ] LangGraph Client；
- [ ] production endpoint。

---

## Phase 3：Chat UI

- [ ] Thread；
- [ ] Message；
- [ ] Markdown；
- [ ] Composer；
- [ ] Reasoning；
- [ ] ActionBar；
- [ ] Scroll；
- [ ] Sonner。

---

## Phase 4：Tool UI

- [ ] Tool Registry；
- [ ] GNSS；
- [ ] Weather；
- [ ] Station；
- [ ] Vision；
- [ ] Site Environment；
- [ ] Map；
- [ ] 大数据性能。

---

## Phase 5：Thread Sidebar

- [ ] Router；
- [ ] TanStack Query；
- [ ] Pagination；
- [ ] Rename；
- [ ] Delete；
- [ ] Busy；
- [ ] Mobile Sheet。

---

## Phase 6：Agent 状态

- [ ] Run Status；
- [ ] Context Usage；
- [ ] Recommendations；
- [ ] Error；
- [ ] Connection；
- [ ] Interrupt。

---

## Phase 7：清理与切换

- [ ] 删除旧 frontend；
- [ ] 删除兼容代码；
- [ ] 删除旧依赖；
- [ ] 更新 Docker；
- [ ] 更新 README；
- [ ] 更新 TODO；
- [ ] CI 全绿。

---

# 40. 暂时明确不做

这一版暂不做：

```text
Artifact 工作台
Evidence 独立侧栏
三栏布局
Artifact Store
图片迁 object storage
signed URL
Base64 迁移
消息大数据拆分
完整 GenUI
多 Agent UI
完整 branch picker
```

这些全部作为 Frontend V2 稳定后的后续阶段。

---

# 41. 后续自然演进路线

Frontend V2 稳定之后再按优先级：

```text
V2.1
Attachment

V2.2
Agent Status Bar 增强

V2.3
Evidence UI

V2.4
Artifact Panel

V2.5
Controlled GenUI

V2.6
Subagent visualization
```

这样当前重构不会因为“未来可能需要工作台”而提前复杂化。

---

# 42. 最终验收标准

完成后必须满足：

- [ ] React 19；
- [ ] Vite 8；
- [ ] Tailwind 4；
- [ ] assistant-ui；
- [ ] shadcn/Radix；
- [ ] LangGraph `useStream` 仍是运行时核心；
- [ ] assistant-ui `useStreamRuntime`；
- [ ] 不存在第二份 message state；
- [ ] Chat UI 基本全部由 assistant-ui；
- [ ] 通用 UI 基本全部由 shadcn/Radix；
- [ ] Toast 使用 Sonner；
- [ ] Thread Router 使用 React Router；
- [ ] Thread resource 使用 TanStack Query；
- [ ] Tool execution 只发生在后端；
- [ ] Tool UI 使用统一 registry；
- [ ] 大型 Tool 数据仍可在消息内工作；
- [ ] Base64 图片仍可正常历史恢复；
- [ ] 页面整体样式保持现有 LMA 风格；
- [ ] Thread 切换流式恢复正常；
- [ ] Tool 返回即完成；
- [ ] Stop 正常；
- [ ] Regenerate 正常；
- [ ] Interrupt 正常；
- [ ] Production 不暴露 LangGraph 地址配置；
- [ ] 旧 Chat UI 代码全部删除；
- [ ] 无兼容旧实现的冗余逻辑；
- [ ] E2E / visual regression 全部通过。

---

# 43. 一句话目标

> **Frontend V2 不再维护自己的 Chat 框架：LangGraph 管 Agent，assistant-ui 管对话，shadcn/Radix 管基础交互，LMA 只管监测领域内容；暂时继续让大数据和图片跟随消息，不提前引入工作台和 Artifact 基础设施。**
