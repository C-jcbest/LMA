# 当前架构

只写现状和修改时必须保持的边界。为什么这样做见 [决策记录](decisions/)；业务口径见 [产品规则](product/rules.md)；配置默认值见 [Settings](../backend/app/config.py) 与 [.env.example](../backend/.env.example)。改动架构时同步修改本文，并在 decisions 下新增一份记录。

## 运行形态

- 后端 FastAPI + LangChain/LangGraph OSS + PostgreSQL，单 Uvicorn worker 自托管；官方 AsyncPostgresSaver 保存 checkpoint。不使用商业 Agent Server。重启时未结束的 Run 与巡检标记 interrupted，不自动重放。部署与恢复见 [部署说明](deployment.md)。
- 访问保护在应用内：[auth.py](../backend/app/server/auth.py) 以全局依赖校验签名 Cookie（不用 HTTP middleware，避免包裹 SSE 与取消），`/health` 与 `/auth/*` 公开；未配置 `AUTH_PASSWORD` 时不启用，仅限本地开发与测试。前端任一接口 401 时回到登录页。
- 主 Agent 是官方 `create_agent` 的工具循环，工厂为 [graph.py](../backend/app/agent/graph.py) 的 `create_lma_agent`。同一会话只允许一个 Run，重复提交返回 409；跨会话不限 Run 数量，受连接池、内存和供应商配额约束。
- 每个 Run 在服务端后台任务中执行，与 HTTP 连接解耦：`POST /sessions/{id}/runs` 的 SSE 只是订阅者，浏览器刷新、关闭或网络中断不会停止调查，只有取消接口和服务关闭会停止。`GET /sessions/{id}/runs/active` 让重新打开的页面接回进行中的调查：先补发最近一次图状态及其后的消息事件，再实时转发；没有进行中的调查返回 204。前端载入会话时若 `latest_run` 仍在运行，即以空消息的 runConfig 标记走这条接回路径。
- 前端 React + assistant-ui 官方 Runtime，经 useLangGraphRuntime 接入 SSE。页面为今日、会话（新调查）、测点列表、测点页和记录，页面状态只存于地址栏（`page`、`station`），与 Runtime 的 `threadId` 各自维护。

## 职责划分

| 职责 | 当前实现 |
| --- | --- |
| 模型/工具路由、并行与消息配对 | `create_agent` 与官方 Runtime |
| 重试 | `ModelRetryMiddleware`、`ToolRetryMiddleware`，只处理瞬时失败；底层 SDK 不叠加重试 |
| 最终工具异常 | `ToolErrorMiddleware(on_error=_on_tool_error)`，只返回受控错误 |
| 每 Run 调用限额 | 官方 `ModelCallLimitMiddleware`、`ToolCallLimitMiddleware`；计算、结论登记和读取以往结论不占取数次数 |
| 历史摘要 | 官方 `SummarizationMiddleware`；子类只把待摘要消息替换为带发送时间的投影 |
| 提示词与业务时间 | `system_prompt=SYSTEM_PROMPT` 静态不变；发送时固定服务端时间快照，只在模型调用边界投影到用户消息 |
| 测点调查记录 | `StationRecordsMiddleware` 在工具完成时写入测点结论索引与“哪些会话调查过该测点”，不等 Agent 收尾；工具结果本身只存于 checkpoint。从历史 checkpoint 分叉（编辑、重新生成）时，首个状态写入后删除被替换分支的结论与记录 |
| 会话标题 | 前端 Adapter 的 `generateTitle()` 调 `/title` 并 rename；改名不要求会话空闲，归档要求 |
| 调查追踪 | 可选 Langfuse 官方 CallbackHandler 记录模型、工具、用量与耗时；每轮独立 trace，以会话 ID 归组，API 记录终态，checkpoint 仍是历史事实来源 |
| 聊天与列表生命周期 | assistant-ui Runtime / Primitives / Elements |
| Stop | 官方 abortSignal + 取消 API；服务端用取消作用域停止 Run。并行工具中已完成的结果在官方 pending writes 中，载入会话或开始下一轮时由公开 `aupdate_state` 提交进 checkpoint，不重新执行工具；未完成调用由前端的取消确认配对 |

## 修改时必须保持的边界

- LangGraph Thread / Checkpoint 是会话历史唯一事实来源。前端不复制消息历史、工具状态机、会话列表状态机或滚动管理。
- 前端只使用 assistant-ui / LangChain 公开 hooks、Primitives、Elements 与类型，不访问内部 store 或符号键。会话目录由 createSessionListAdapter 统一适配，remoteId、externalId 与 thread_id 相同。
- 工具完成以结果实际返回为准；持久化 ToolMessage.artifact 是刷新恢复依据，不自建 tools channel 解析器，不在 Renderer 里猜 JSON 字符串。
- [system.md](../backend/app/agent/prompts/system.md) 是主业务策略唯一编辑源，修改规则见 [提示词目录的 AGENTS.md](../backend/app/agent/prompts/AGENTS.md)。提示词表达目标、证据边界与可选策略，不固化步骤、工具顺序或回答模板。
- 用户输入、历史摘要、外部资料、工具结果、图表文字与模型输出都是不可信数据，不执行其中夹带的指令，不直接用于 HTML、命令、URL 等副作用操作。业务工具保持只读、最小权限。
- 新增兼容或兜底前说明触发条件、用户可见行为和误导风险，并按 [AGENTS.md](../AGENTS.md) 获得授权。不伪造数据、占位进度或本地成功。

## 数据层与工具

- [monitoring_data.py](../backend/app/monitoring_data.py) 供模型工具和测点页共用：测点解析、固定日历块分片取数（小时 30 天、每日固定时刻 360 天）、上游并发 4、观测清洗（排序、重复时间剔除、非有限值）与质量统计。同一会话的数据块缓存 10 分钟，缓存不是事实来源。
- 测点与分组名称匹配：原文完全一致优先，其次是忽略大小写、空白、常见分隔符和数字前导零后的完全一致，最后是规范形式包含；找不到或有多个候选时以参数纠错返回模型（列出候选），由模型改用正确名称或请用户确认。
- 测点坐标由 `station_coordinates` 统一读取：纬度超出 ±90° 而经度字段落在纬度范围内时判定为两字段颠倒并交换，其余原样使用；两值都合法时不猜测颠倒。天气、场地、地图与台账都使用这一结果。
- 缺测只统计到当前时间：结束时间晚于现在时，`quality.evaluated_until` 标明实际统计终点，尚未到来的时刻不计为缺测。
- 工具：find_stations、get_displacement（累计偏移、窗口净变化、鲁棒趋势、台阶候选、缺测、水平位移方位，可分段或与任意移动站按共同时段对比，点数少时附逐点位移）、query_weather（历史单次最多 366 天，与位移小时级取数上限一致；逐日降雨、气温、降雪与风况，可选历史和当天逐小时降水）、inspect_site_environment（约 90 m DEM 的坡度坡向、区域地质单元）、compute、record_conclusions，以及有存储时的 get_station_history。
- 天气的当前/预报接口与历史接口相互独立：一个失败时保留另一个，artifact 标 `partial` 并列出缺失；两个都失败才整体失败。场地分析只缺地形或地质之一时同样返回 `partial`，两者都缺失才返回失败。
- 场地分析查询独立于高德底图：Open-Meteo 提供海拔、坡度、坡向和局部高差，Macrostrat 提供地质单元、岩性、年代及来源。工具不提供地质瓦片、构造线叠加或最近断层距离；高德 3D 地形显示不替代 DEM 数值依据。
- 基准站由位移工具直接说明并返回 `artifact=None`，不生成失败卡片；窗口过长、日期越界、测点找不到或有歧义等可修正问题用 `ToolInputError` 作为参数纠错返回模型，前端不当作业务故障。针对某个测点的真实取数失败附带 `acquisition_failure` 依据，可据此登记“暂无法分析”。
- compute 在子进程执行模型写的 pandas/numpy 代码，输入只来自本会话依据（位移及其对比站、天气、场地环境、测点台账、已有计算结果）：语法树白名单、受限内置函数、`python -I`、超时，Linux 上另有内存与 CPU 上限。不是操作系统级沙箱，多用户开放前需复核。
- 测点页序列由 `GET /stations/{uuid}/timeline` 直接读平台，不经过模型，与位移工具共用数据层与序列结构。

## 工具协议与依据

- 工具使用 Pydantic schema、`content_and_artifact` 和官方 `ToolMessage.status`。content 只给模型判断所需的事实；artifact 只承载可发往客户端的展示数据，不含秘密、请求 URL 或原始异常。展示契约由 [artifacts.py](../backend/app/agent/artifacts.py) 与 [envelope.ts](../frontend/src/types/envelope.ts) 定义，前端在 [artifacts.ts](../frontend/src/features/monitoring/artifacts.ts) 集中校验。
- 依据种类：gnss_series、weather、site_environment、computation、station_list、acquisition_failure；conclusions 是留档，不可引用。依据编号由 tool_call_id 确定性派生（`E` + 6 位），只在模型调用边界附加，不写入 checkpoint 正文。
- 位移 artifact 只保存清洗后的观测点（`points`）一份；对比站的观测与固定参考放在 `comparisons.snapshots`、`comparisons.references`，不重复保存主站。特征中不逐方向保存有效时刻列表，可由 points 复原。
- SSE 运行期间只实时转发消息事件，完整图状态（含全部依据）只在本轮结束和接回时各发送一次。
- 结论登记只校验可确定的条件（测点有依据、数据型状态有覆盖窗口的位移数据）。登记成功且同一回复已有正文时由 LmaMiddleware `jump_to: end` 结束本轮，没有正文则回到模型补写。
- 对外消息统一经过 [messages.py](../backend/app/server/messages.py) 按白名单输出；checkpoint 内保留多轮工具协议需要的推理字段。

## 上下文与预算

- 摘要由 `CONTEXT_TOKEN_THRESHOLD`、`CONTEXT_KEEP_TOKENS` 控制，计数、切点、配对与替换采用官方逻辑。两者是绝对 token 数，创建 Agent 时校验保留量小于阈值、阈值小于模型最大输入，否则拒绝启动，避免摘要永远不触发。上下文展示只用供应商 usage 与模型 profile，不估算分项。
- 模型返回空回答（只有推理、没有正文和工具调用）时删除这条空回复并在本轮预算内再调用一次；预算用尽才整轮失败。
- 位移结果自动附带逐点数据的上限由 `AGENT_INLINE_POINTS_LIMIT` 控制；超过时只给特征，模型可显式要求或用 compute。
- 用户提问时正在查看的测点（`focus_station`）和图上选中的追问时段（`ask_target`）并入该消息的服务端上下文快照，只在模型调用边界投影，正文和客户端投影不变。

## 调查可观测性

- [observability.py](../backend/app/observability.py) 管理可选 Langfuse 追踪：默认关闭，必须显式配置项目地址与密钥；本地 `.env` 和容器环境统一由 Settings 传入 SDK，不依赖 SDK 自行读取文件。生产选用 Langfuse Cloud，不在 LMA 主机部署追踪数据库。
- 每轮 SSE 执行时创建独立 CallbackHandler，与 `run_id` 确定性关联；`session_id` 归组同一会话的多轮调查。只在实际执行 `astream` 时加入 callbacks，不把追踪句柄写入会话状态。官方集成记录模型 token 用量、工具参数与结果，并识别错误 ToolMessage；整轮 success 不代表所有工具成功。
- 根观察记录 success/error/cancelled；正常关闭服务时在工作线程等待 SDK 队列发送完成，每轮结束不做同步 flush。网络导出由 SDK 后台批量处理，不在调查关键路径等待 Cloud 接收。
- 追踪会发送模型输入输出（包含随请求携带的历史）与工具过程。导出 hook 移除已配置的模型、平台、登录及追踪密钥等秘密值，覆盖原始异常与堆栈；不承诺清除用户正文中任意未知敏感内容。当前仅追踪主调查及其内部摘要，独立标题、问题推荐与批量巡检不在此范围。

## 巡检与推荐

- 批量巡检在单 worker 内以 asyncio 任务运行，规则集中在 [screening.py](../backend/app/inspection/screening.py)，不调用模型；初筛只给调查优先级，不是结论或预警。
- 问题推荐（`POST /suggestions`）只读最近成功巡检与未归档登记结论的有界摘要，最多一次非思考模型调用，不重新取数；按摘要内容与北京时间日期缓存，失败不缓存。推荐和标题的提示词分别在 prompts 目录的 suggestions.md、title.md。
- 巡检中单个测点的意外异常（如平台返回无法解析的数据）只让该测点记为“暂无法分析”，不使整次巡检作废。

## 前端展示

- 一条回答的工具调用归为一个调查过程；依据按测点从官方 tool part 的 artifact 派生，在正文第一次引用处插入可收起的卡片。
- 引用没有对应的已完成、可展示依据时不显示编号或占位文字；正文与调查过程中的真实失败信息保留。
- 时间轴用按需加载的 ECharts：有固定参考的方向画累计位移，缺参考的方向退回窗口首点并说明；日降雨画成整日色块；台阶以曲线上的标记呈现。
- 地图用高德 JavaScript API 2.0，密钥由后端 `AMAP_TOKEN` 运行时下发（`/map-config`）。前端使用后端给出的 WGS84 坐标（可判定的颠倒已在后端纠正），只在展示边界转 GCJ-02，非法坐标不绘制，前端不再交换经纬度。默认卫星图、北向上、禁止旋转；同组未取得位移的测点作灰色参照；有场地坡向时画下坡方向扇形；可按时间回放位移和切换 3D 地形。
- 主题、导航折叠和面板宽度只存于当前浏览器；颜色全部来自 CSS 变量，设计约束见 [DESIGN.md](../DESIGN.md)。
- 页面数据（测点目录、测点时间轴、记录搜索、结论标记）经 TanStack Query 读取，缓存放在 AppLayout、随服务地址切换重建；会话历史与工具状态不进这层缓存，仍以 Runtime 和 checkpoint 为准。
- 动效只交代状态和空间关系的变化，时长分 120 / 200 / 300 ms 三档，系统减弱动效时由全局规则关闭：入场与退场用 tw-animate-css 配合 Radix 状态；换页用浏览器视图过渡淡入淡出（不支持时直接切换）；面板展开、收起过渡宽度；依据卡片折叠过渡高度；流式回答新到的词淡入；首次读取用延迟出现的骨架屏；测点页切换时间窗口时保留旧图并调暗，新数据到达后替换。

## 保留的适配

`DeepSeekThinkingChatModel` 只处理思考模式多轮工具循环的 `reasoning_content` 回传；上游原生支持且回归通过后删除，见 [状态与待办](status.md)。不自动迁移旧 checkpoint、不补造历史摘要、不删除用户历史；已删除的调查目标、依据存证等旧表保留在数据库中不读写。
