---
name: LMA Monitor
description: 滑坡监测智能体的前端设计系统：中性界面，颜色只表达业务状态
colors:
  background: "hsl(0 0% 100%)"
  foreground: "hsl(240 10% 8%)"
  sidebar: "hsl(240 5% 97.5%)"
  muted: "hsl(240 5% 95.5%)"
  muted-foreground: "hsl(240 4% 42%)"
  card: "hsl(0 0% 100%)"
  popover: "hsl(0 0% 100%)"
  border: "hsl(240 6% 90%)"
  ring: "hsl(240 5% 65%)"
  primary: "hsl(240 6% 10%)"
  primary-foreground: "hsl(0 0% 98%)"
  destructive: "hsl(2 72% 48%)"
  status-normal: "hsl(152 60% 36%)"
  status-attention: "hsl(36 92% 46%)"
  status-critical: "hsl(2 72% 48%)"
  status-unknown: "hsl(240 4% 66%)"
  chart-north: "hsl(212 86% 46%)"
  chart-east: "hsl(168 72% 32%)"
  chart-up: "hsl(22 86% 50%)"
  chart-rain: "hsl(205 72% 62%)"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.025em"
  title:
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.5
  reading:
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.75rem"
  body:
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  base: "4px"
  row-y: "10px"
  row-x: "12px"
  page-gutter: "16px–24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "36px"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "36px"
  list-row:
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  station-chip:
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "36px"
  evidence-card:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.lg}"
    padding: "2px 12px 10px"
  input:
    rounded: "{rounded.md}"
    height: "36px"
---

# Design System: LMA Monitor

现行规范。Token 的唯一来源是 [frontend/src/styles/index.css](frontend/src/styles/index.css)，本文的数值与它不一致时以 CSS 为准并修正本文。组件源码在 [frontend/src/components/ui](frontend/src/components/ui)。

## Overview

**Creative North Star: "值班台上的仪表"**

使用者在办公室电脑上独自查看几十个监测点，一天里反复回来确认“哪里变了、为什么”。界面要像一块安静的仪表盘：平时几乎全是中性灰，只有需要注意的测点、需要读的曲线和可以点开的依据会跳出来。界面属于 Operate 模式，可扫读、行为一致比表现力重要，品质体现在精确的细节上。

信息密度中等偏高：列表行紧凑，回答正文用略小于 16px 的阅读字号，数字一律等宽。界面元素平铺，层次靠分隔线和浅底色区分，不靠阴影堆叠。动效只交代状态和空间关系的变化，不做装饰。

**Key Characteristics:**

- 中性灰的界面，颜色只表达业务状态（正常、需注意、严重、未知）和图表系列。
- 平面化：1px 分隔线和浅底色区分层次，阴影只给浮层。
- 每个可点击元素都有悬停、按下、键盘焦点和禁用四种状态，鼠标指针是手型。
- 依据卡片和句末引用编号是回答的核心交互，始终可点、可展开。
- 浅色、深色、跟随系统三种主题，所有颜色来自 CSS 变量。

## Colors

中性色占绝大部分画面；状态色是稀缺信号，每屏只出现在真正需要注意的地方。

### Primary

- **墨黑** (`--primary` hsl(240 6% 10%)，深色主题 hsl(0 0% 94%))：主按钮、选中的发送按钮、进度条填充。整屏通常只有一个主按钮。

### Neutral

- **纸白** (`--background` hsl(0 0% 100%)，深色 hsl(240 6% 8%))：页面底色。
- **侧栏灰** (`--sidebar` hsl(240 5% 97.5%)，深色 hsl(240 6% 10.5%))：导航和窄导航条。
- **雾灰** (`--muted` / `--accent` hsl(240 5% 95.5%)，深色 hsl(240 5% 16%))：悬停底色、选中项、依据卡片底色、表头。
- **铅灰文字** (`--muted-foreground` hsl(240 4% 42%)，深色 hsl(240 5% 66%))：次要信息、元数据、表头文字。
- **分隔线** (`--border` hsl(240 6% 90%)，深色 hsl(240 5% 20%))：所有边框和分隔线，Tailwind 的默认边框色已在 base 层统一为它。
- **焦点环** (`--ring` hsl(240 5% 65%)，深色 hsl(240 5% 46%))：键盘焦点、拖动分隔线、引用编号悬停描边。

### 业务状态色

- **正常** (`--status-normal`)：未见明显变化、平台状态正常。
- **需注意** (`--status-attention`)：建议调查的测点、徽标计数、新变化的行高亮。
- **严重** (`--status-critical`)：需处置的结论、平台故障。
- **未知** (`--status-unknown`)：数据待核查、离线、无结论。
- **提醒** (`--warning`，取值同“需注意”)：界面层面的提醒，例如上下文将满，语义上与业务状态分开。
- **错误** (`--destructive`)：操作失败、表单校验错误、删除等破坏性操作。

### 图表色

`--chart-north` / `--chart-east` / `--chart-up` 对应北、东、垂直三个方向，`--chart-rain` 为降雨，`--chart-peer` 为同组参照，`--chart-gap` 为缺测区间。图表通过 `useChartColors` 读取，不在图表配置里写色值。

### Named Rules

**状态色专用规则。** 状态色只用于状态点、状态文字和图表，不做按钮底色、背景装饰或品牌色。一行里最多一个状态色元素。

**不写色值规则。** 业务组件只用语义类（`bg-background`、`text-muted-foreground`、`border-border`、`text-status-attention` 等），不写 `bg-gray-100`、`text-zinc-600`、十六进制或 hsl。例外：遮罩层 `bg-black/50`（CLI 生成的 Dialog / Sheet），以及高德地图标记的 CSS（地图 DOM 不归 React 管，仍须引用 CSS 变量）。

## Typography

**Body Font:** 系统字体栈（-apple-system、Segoe UI、PingFang SC、Microsoft YaHei、Noto Sans CJK SC）

**Character:** 用操作系统自带的中文字体，保证办公室 Windows 电脑上清晰、加载为零。层级靠字号和字重，不靠字体对比。

### Hierarchy

- **Headline**（600，`text-2xl`，宽屏首页 `sm:text-3xl`，`tracking-tight`）：页面标题，如“今日”“测点”“调查记录”。
- **Title**（600，`text-lg` / `text-base`）：测点名、面板标题。
- **Reading**（400，`text-reading` 15px / 28px）：回答正文。介于 `text-sm` 与 `text-base` 之间，长段落更紧凑。
- **Body**（400，`text-sm` 14px）：界面文字、列表、按钮。
- **Label**（400，`text-xs` 12px）：元数据、表头、图例、分组标签。

### Named Rules

**等宽数字规则。** 位移、时间、计数、表格一律 `tabular-nums`，数字纵向对齐，跳动时宽度不变。

**预设字号规则。** 只用 `text-xs` 到 `text-3xl` 和主题里的 `text-reading`，不写 `text-[13px]` 之类的任意值。

## Layout

- **栅格**：4px 基线，间距只用 Tailwind 预设刻度（`1` = 4px、`2` = 8px、`3` = 12px、`4` = 16px、`6` = 24px）。
- **页面列**：今日、测点、记录三个页面共用 `.page-column`，最大宽度 52rem、左右留白 16–24px，与对话列对齐；测点页数据区 `.station-data` 最大 60rem。
- **列表行**：`.today-row` / `.station-row` / `.record-row` 用 CSS Grid，行内 12px 左右、10–14px 上下；按列表自身宽度（容器查询）切换列数，而不是按窗口宽度。
- **面板**：导航 260px（可拖到 220–420px）；依据面板与测点页对话栏可拖动宽度，保存在当前浏览器；视口不够时临时收窄，不回写偏好。
- **断点**：`768px` 以下导航改为抽屉（Sheet）、依据面板全屏覆盖；`1100px` 起测点页数据与对话并排；`1280px` 起测点页可同时停靠导航；`1680px` 起三栏同时停靠。
- **安全区**：贴边的头部和底部用 `env(safe-area-inset-*)`，这是允许的任意值。

## Elevation & Depth

平面系统。静止的表面不加阴影，层次靠 1px 分隔线和雾灰底色区分；阴影只说明“这一层浮在内容之上”。

### Shadow Vocabulary

- **浮层**（`shadow-lg`）：Sheet 抽屉、Dialog、弹出菜单。
- **悬浮工具条**（`shadow-sm`）：图表上的“问这段”工具条、地图标记的信息标签。
- **输入面**（`shadow-xs`）：输入框、对话输入区、outline 按钮。

### Named Rules

**卡片不浮起规则。** 卡片和列表行不使用阴影；依据卡片用浅底色而不是边框加阴影，读起来像正文里的附图。一个元素只选一种层次表达：边框或阴影，不同时用。

## Shapes

`--radius` 为 0.75rem，派生 `rounded-sm` 8px、`rounded-md` 10px、`rounded-lg` 12px、`rounded-xl` 16px。

- **按钮、输入框、开关组**：`rounded-md`。
- **列表行、依据卡片、表格外框、提示框**：`rounded-lg`。
- **对话输入区与用户消息气泡**：`rounded-xl`（`--composer-radius`）。
- **胶囊**：只给小控件，测点入口、图表追问按钮、引用编号用 `rounded-full`。
- **图表柱**：`rounded-xs` / `rounded-t-xs`。

不使用 `rounded-2xl` 及更大的自定义圆角；不使用超过 1px 的彩色侧边框做卡片或提示（Markdown 引用块的 2px 左边线是正文排版，不算卡片）。

## Components

### Buttons

- **Shape:** `rounded-md`，默认高 36px（`h-9`），小号 32px、超小 24px；图标按钮正方形。
- **Primary:** 墨黑底、纸白字；每屏一个。
- **Outline / Ghost / Link:** outline 用于次要操作和错误恢复；ghost 用于工具栏和图标按钮；link 用于句内“重试”，保留下划线提示可点击。
- **States:** 悬停底色加深或换为雾灰；按下 `active:scale-98`（图标按钮 `scale-95`）；键盘焦点 `ring-2 ring-ring`；禁用 50% 透明且不响应指针；加载时前置旋转的 `Loader2Icon` 并禁用。
- **Source:** [button.tsx](frontend/src/components/ui/button.tsx)；所有按钮都用它，不手写按钮样式。

### Chips

- **测点入口**：`rounded-full` 胶囊、1px 边框、带迷你趋势线；选中时边框加深并铺雾灰底（`aria-pressed`）。
- **追问对象**：`rounded-md` 雾灰底、超小删除按钮。

### Evidence Card（标志组件）

- 正文第一次引用某条依据时插入，宽度与正文一致；雾灰底、`rounded-lg`、无边框无阴影。
- 标题行整行可点，展开收起用 Collapsible 的高度过渡；放大按钮平时隐藏，悬停或键盘聚焦卡片时出现，触屏始终显示。
- 句末引用编号是 20px 胶囊，悬停描边变为焦点环色，点击打开依据面板；触屏扩大透明点击区。

### Lists / Rows

- 整行是一个按钮：`rounded-lg`，悬停 `bg-muted/60`，按下 `active:scale-99`，当前项 `aria-current` 铺雾灰。
- 筛选或巡检更新后新出现的行淡入（`animate-in fade-in duration-200`）；结论有变化的行底色亮起一次再褪去（`.row-changed`）。

### Inputs / Fields

- **Style:** 1px `border-input`、透明底（深色主题 `bg-input/30`）、`rounded-md`、`shadow-xs`。
- **Focus:** 边框变为焦点环色并加 `ring-2 ring-ring/30` 的柔和光晕。
- **Error / Disabled:** `aria-invalid` 时边框为错误色；禁用 50% 透明。
- 表单目前只有登录和对话输入，用受控组件即可；出现多字段、需联动校验的表单时，再引入 `react-hook-form` + `zod` + shadcn Form。

### Navigation

- **侧栏**：侧栏灰底，页面入口 36px 高、`rounded-md`，当前页雾灰底加粗；“今日”带需注意计数。
- **窄导航条**：侧栏收起后保留 48px 宽的图标条，入口位置不变。
- **抽屉**：窄屏用 [Sheet](frontend/src/components/ui/sheet.tsx) 从左侧滑入，宽度沿用侧栏偏好。

### Tabs / Toggle Groups / Tables / Progress

- **页签**：[tabs.tsx](frontend/src/components/ui/tabs.tsx) 的 `line` 变体，下划线贴住列表底边。
- **开关组**：主题切换与筛选用 [toggle-group.tsx](frontend/src/components/ui/toggle-group.tsx)，选中项雾灰底；筛选包装为 [Segmented](frontend/src/components/ui/segmented.tsx)。
- **数据表**：[table.tsx](frontend/src/components/ui/table.tsx) 已收敛为紧凑数据表（表头雾灰、单元格 `px-3 py-1.5`、等宽数字、行悬停）。外层已负责滚动时传 `containerClassName="overflow-visible"`，保证粘性表头可用。
- **进度**：[progress.tsx](frontend/src/components/ui/progress.tsx)，巡检进度条 4px 高。

### Loading / Empty / Error

- **加载**：首次读取用骨架屏，延迟 150ms 再淡入，读取很快时不闪；进行中的文字用扫光（`.text-shimmer`）。
- **空状态**：一句话说明现状，例如“暂无测点。”“还没有调查记录。”，不放插画。
- **错误**：说明哪部分没载入，并给出重试；局部失败不打断整页（ErrorBoundary 的局部样式）。

### 交互状态与动效

- **时长**：反馈 120ms（`--duration-fast`）、状态切换 200ms（`--duration-base`）、面板与视图 300ms（`--duration-slow`）；Tailwind 类用 `duration-150 / 200 / 300`。
- **曲线**：进入与反馈用 `--ease-out`（cubic-bezier(0.22, 1, 0.36, 1)），离开用 `--ease-in`；Tailwind 的 `ease-out` / `ease-in` 已指向这两条曲线。
- **入场**：用 tw-animate-css 的 `animate-in fade-in zoom-in-95 slide-in-from-*` 等类，配合 Radix 的 `data-[state]` 做退场。
- **流式回答**：新到的词 200ms 淡入（Streamdown `animated`），不做打字机延迟。
- **换页**：浏览器视图过渡淡入淡出 160ms，不支持时直接切换。
- **减弱动效**：系统开启“减少动态效果”时，index.css 的全局规则把动画和过渡压到瞬时，组件里不再逐个写 `motion-reduce:`。

### Map Markers

高德地图标记是纯 CSS（`.evidence-map-marker*`、`.map-station-popup*`），尺寸用 px，颜色仍引用 CSS 变量。位移方向直接在地图上画箭头，不另做独立的方向指示组件（见 [0010](docs/decisions/0010-keep-answer-presentation.md)）。

## Do's and Don'ts

### Do:

- **Do** 用 `pnpm dlx shadcn@latest add <component>` 生成组件到 `components/ui`，再按本文收敛样式。
- **Do** 用 `cn()`（从 `cn` 包引入，与 CLI 生成的组件一致）合并类名，让调用方能覆盖样式；不用模板字符串拼类名。
- **Do** 每个可点击元素都写全悬停、`active:` 按下、`focus-visible:ring-2 ring-ring` 与禁用状态。
- **Do** 数字用 `tabular-nums`，状态用状态点加文字，不只靠颜色。
- **Do** 图标只用 Lucide，统一 `size-4`（小号 `size-3.5`），装饰性图标加 `aria-hidden`。
- **Do** 新增颜色、字号、时长先加到 index.css 的 Token，再在组件里用对应的类。
- **Do** 静态资源放 `public/` 或 `src/assets`，用 `@/` 别名引用。

### Don't:

- **Don't** 在业务组件里写调色板色值或任意像素值（`w-[8px]`、`text-[14px]`、`p-[13px]`）。允许的例外：画布、SVG、地图和图表的动态定位；`env(safe-area-inset-*)`；`min()` / `calc()` 等需要运行时计算的尺寸；`data-[state=…]` 等变体选择器；`grid-cols-[repeat(auto-fit,…)]` 这类布局函数；CLI 生成组件自带的值。
- **Don't** 用 `rounded-2xl` 及以上的自定义圆角，也不要用大于 1px 的彩色侧边框做卡片。
- **Don't** 给卡片和列表行加阴影，或同时使用边框和阴影。
- **Don't** 用 Emoji 或 Unicode 符号代替图标。
- **Don't** 加装饰性动画（悬浮上移、视差、滚动揭示）；动效只交代状态变化。
- **Don't** 改动回答的整体呈现、去掉可点击的依据卡片，或在地图之外另做方向指示；回答呈现的取舍见 [0010](docs/decisions/0010-keep-answer-presentation.md)。
- **Don't** 引入 Magic UI、Aceternity 一类装饰组件库，或与现有能力重复的动画、状态库。
