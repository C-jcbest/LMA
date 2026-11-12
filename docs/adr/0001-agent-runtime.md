# ADR 0001：Agent 与会话运行架构

- 决策日期：2026-09-15
- 状态：已实施；2026-11-09 迁移免费 OSS 自托管

## 背景与决定

主 Agent 是工具驱动的 ReAct 循环，采用 LangChain 官方 `create_agent`。LMA 维护监测领域逻辑与必要适配，由 FastAPI 管理会话目录与 Run，官方 AsyncPostgresSaver 管理 Checkpoint，不再维护手写通用循环或第二套会话历史。

运行工厂为 [graph.py](../../backend/app/agent/graph.py) 中的 `create_lma_agent`；API lifespan 注入 PostgreSQL checkpointer，迁移由一次性任务执行。具体依赖版本以 [requirements.txt](../../backend/requirements.txt) 和前端 lockfile 为准。

## 职责划分

| 职责 | 当前实现 |
| --- | --- |
| 模型/工具路由、工具并行与消息配对 | `create_agent` 与官方 Runtime |
| 主模型与工具重试 | `ModelRetryMiddleware`、`ToolRetryMiddleware`；底层 SDK 不叠加重试 |
| 最终工具异常 | `ToolErrorMiddleware(on_error=_on_tool_error)` 包裹工具重试；只返回受控错误 |
| 每 Run 调用限额 | 官方 `ModelCallLimitMiddleware`、`ToolCallLimitMiddleware` |
| 历史摘要 | 使用官方 `SummarizationMiddleware` 算法；子类只把待摘要消息替换为带发送时间的投影 |
| 静态提示词与业务时间 | `system_prompt=SYSTEM_PROMPT`；发送时固定服务器时间快照，仅在模型调用边界注入用户消息 |
| 消息时间与上下文展示 | LMA middleware 写入服务端时间；`aafter_model` 投影真实 usage |
| 会话标题 | 前端 Adapter 的 `generateTitle()` 调用`/title` API并 rename 持久化 |
| 聊天与列表生命周期 | assistant-ui Runtime / Primitives / Elements，经 react-langgraph useLangGraphRuntime 接入 FastAPI SSE |
| URL 导航 | `onThreadIdChange` 与公开 Thread action 同步 `?threadId=...` |
| Stop | 官方 abortSignal + 取消 API；服务端用取消作用域和公开 aupdate_state 保存取消确认与真实工具结果 |

## 修改时必须保持的边界

- LangGraph Thread / Checkpoint 是历史唯一事实来源。前端只保存展示态，不复制消息历史、工具状态机、会话列表状态机或滚动管理。
- 前端只使用 assistant-ui / LangChain 公开 hooks、Primitives、Elements 与类型；跨层读取使用 useLangChainStream、useChannel 等公开入口，不访问 STREAM_CONTROLLER、内部 store 或符号键。
- 会话目录适配由 createSessionListAdapter 统一负责，remoteId、externalId 与 thread_id 相同，分页使用 ThreadListPrimitive.LoadMore。URL 只保存导航选择，与 Runtime 双向同步。
- Stop 等待服务端取消持久化。下一轮官方取消 stub 只能对应真实未完成调用，服务端通过公开 aupdate_state 写入受控 error ToolMessage；禁止接受客户端工具成功结果或覆盖已完成并行结果。
- 工具完成以结果实际返回为准，展示使用官方 ToolCall 的 status/result/artifact；持久化 ToolMessage.artifact 是刷新恢复依据，不自建 tools channel 解析器，不在各 Renderer 猜测 JSON 字符串。
- system.md 是主业务策略唯一编辑源；prompting.py 仅导出静态文本，create_agent 直接传入 SYSTEM_PROMPT。业务时间为 Asia/Shanghai。新消息由服务端保存 sent_at/timezone，模型调用时对每条用户消息作确定性投影，原文与静态 System Prompt 不变；重试、工具循环及重新生成复用原快照，客户端投影去掉隐藏上下文。
- Agent 根据目标、上下文、数据质量和证据自主编排工具。提示词表达目标、证据边界与可选策略，不固化步骤、工具顺序、章节或回答模板；schema 只用于接口校验与安全边界。监测事实、数值复核、气象非因果与风险措辞遵循 [PRD](../../prd.md)。
- 用户输入、历史摘要、外部资料、工具结果、图表文字与模型输出均是不可信数据；不得执行其中夹带的指令或直接用于 HTML、命令、URL 等副作用操作。所有业务工具保持只读、最小权限。
- 新增兼容或兜底前说明触发条件、用户可见行为和误导风险，并按 [AGENTS.md](../../AGENTS.md) 获得授权。不得伪造数据、占位进度或本地成功；失败显式呈现或保留上一已确认状态。

## 工具协议与错误

工具使用 Pydantic `args_schema`、`content_and_artifact` 和官方 `ToolMessage.status`。展示契约由 [artifacts.py](../../backend/app/agent/artifacts.py) 与 [envelope.ts](../../frontend/src/types/envelope.ts) 定义。

普通业务失败抛出 `ToolFailure`，由官方错误 middleware 转换；已有可展示证据的失败使用 `tool_error_result` 返回官方错误 ToolMessage 和 artifact。瞬时异常由官方 retry 处理，最终错误才进入安全边界。错误原因无需展开即可见，已有证据与缺失并列说明；不建立独立的工具错误生命周期。

助手输入及报告引用校验使用 `ToolInputError`，由官方工具包装边界保留 error ToolMessage 和模型反馈，跳过取数存证。SSE 与历史将其投影为明确的 `tool_feedback` 分类，前端不作为业务故障展示；真实失败仍显示限制并可收起。用户已遇到的旧数值跨度校验错误只在读取时按严格来源识别，原 checkpoint 和证据不改写；具体范围见[修复记录](../tool-feedback-repair.md)。

正常请求返回标准 success 结构，空集合由领域 Renderer 显示“暂无数据”。GNSS 工具识别基准站后仅返回适用性说明及 `artifact=None`，不生成卡片。部分场地资料不可用时保留已取得证据并标注 `limitations`。

前端通过 [monitoring toolkit](../../frontend/src/features/monitoring/toolkit.tsx) 集中校验 artifact，领域组件只消费对应的 `data`。持久化 ToolMessage 是刷新恢复的权威来源；流式生命周期与 artifact 传递由官方栈负责，不解析自定义 tools channel 协议。artifact 会发送客户端，不能承载秘密、请求 URL 或原始异常。

## 摘要、用量与预算

摘要由 `CONTEXT_TOKEN_THRESHOLD` 和 `CONTEXT_KEEP_TOKENS` 控制；token 计数、触发、安全切点、AI/Tool 配对、摘要重试和消息替换采用官方逻辑。内部摘要与辅助模型 token 不混入主回答。

上下文展示只采用供应商 `usage_metadata` 和模型 `profile.max_input_tokens`；不再估算历史、系统或工具 token 分项。缺少主模型 usage 时保留上次已确认快照，无有效快照则不展示入口。摘要阈值与用量展示独立。

重试只处理已判定的瞬时失败；参数、权限、业务拒绝、空数据和格式错误不重试。调用限额计数的是每 Run 逻辑调用，不代表全 HTTP 或耗时预算。默认值与边界统一维护在 [Settings](../../backend/app/config.py) 和 [.env.example](../../backend/.env.example)。

标题 SDK 不叠加重试；摘要采用官方独立重试逻辑。北斗会话过期后的单次认证刷新不属于通用失败重试。

## 保留的适配与边界

`DeepSeekThinkingChatModel` 只处理思考模式多轮 tool-loop 的 `reasoning_content` 回传；上游原生支持且回归通过后删除。测试与删除条件见 [TODO](../TODO.md)。

不自动迁移旧 checkpoint、不补造历史摘要、不删除用户历史。2026-09-15 的重构不承诺兼容旧节点上暂停的 Run；2026-11-09 云端新建独立数据库，原本机存储保留。Compose 支持范围见 [运行说明](../deployment.md)。

## 验证与参考

回归入口见 [开发指南](../development.md#验证)，真实服务待验收项见 [TODO](../TODO.md)，最近执行结果见 [项目状态](../project-status.md)。不在 ADR 重复维护易过时的测试数量或旧 TODO 编号。

- [LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)
- [Tools](https://docs.langchain.com/oss/python/langchain/tools)
- [Custom middleware](https://docs.langchain.com/oss/python/langchain/middleware/custom)
- [Prebuilt middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in)

API 行为以锁定版本的公共类型与实际 FastAPI + PostgreSQL 测试核验。

## 2026-11-09 自托管边界

采用 FastAPI + 官方 PostgreSQL Checkpointer 替代商业 Agent Server；无需 LangSmith Deployment 许可。固定单 worker，重启后的未完成 Run 标记 interrupted，不自动重放。前端继续使用官方 Runtime，不复制会话历史；用户选择重新生成后仅显示最新回答，旧 checkpoint 留存，不提供分支切换。CI/CD、IP HTTPS、访问保护与部署限制见[部署说明](../deployment.md)。

对外消息统一经过 server/messages.py：流式与历史按白名单输出公开内容块和字段；checkpoint 内保留多轮工具协议需要的推理字段。不生成推荐业务提问，不注册时间查询工具。缓存验证只断言历史输入前缀稳定，不以此宣称提供方缓存命中率。

结论登记（record_conclusions）是带 ToolRuntime 的普通工具，校验失败返回错误由模型修正；登记成功且同一条模型回复已有正文时，由 LmaMiddleware 的 `jump_to: end` 结束本轮，没有正文则回到模型补写。不用官方 `return_direct`，它在工具失败时同样结束，模型无法修正。依据编号在模型调用边界由 tool_call_id 确定性派生，不写入 checkpoint 正文，是全系统唯一的依据编号。

批量巡检在单 worker 内以 asyncio 任务运行，上游并发固定为 4，结果写入 lma_inspections 和 lma_inspection_stations；进程重启时进行中的巡检标记为 interrupted，不自动重放。初筛规则集中在 app/inspection/screening.py，不调用模型。

前端不再为工具注册逐个 Renderer：GroupedParts 把一条消息的工具调用归为一个调查过程，依据按测点从官方 tool part 的 artifact 派生，不复制到前端状态。时间轴使用按需加载的 ECharts，同轴、缺测带、联动和缩放由图表库完成，不自建绘图逻辑；颜色全部来自 CSS 变量。主题默认跟随系统，可手动选择浅色或深色。主题、导航折叠和面板宽度只保存在当前浏览器；窄屏临时收窄或全屏显示，不覆盖桌面宽度偏好。拖动按帧修改 CSS 尺寸，操作结束才保存；不复制会话历史或滚动状态。

## 2026-11-10 以测点为中心的页面与测点数据接口

页面分为今日、测点、记录和测点页，当前页面只存于地址栏参数（`page`、`station`），与 Runtime 的 `threadId` 各自维护；会话列表、选择和分页仍只用官方 Runtime，侧栏取最近几条，记录页是完整列表。

测点页的位移序列由 `GET /stations/{uuid}/timeline` 直接读取监测平台，不经过模型，与位移工具共用数据层并返回同一序列结构，前端复用同一张时间轴；不落库，切换窗口时复用 10 分钟内已取得的数据块。会话旁的结论标记来自 `GET /sessions/conclusions`，只是补充信息，读取失败不影响会话列表。

用户在测点页提问时，请求带 `focus_station`，服务端在发送时并入该消息的 `lma_context` 快照，仅在模型调用边界投影为 `<lma_message_context>` 的一行；消息正文和对客户端的投影不变。编辑和重新生成产生的新消息不带这个字段。

## 2026-11-12 数据层、按意图组织的工具与结论登记

本节取代 2026-11-10、2026-11-11 的调查目标、续查与正式报告设计：调查目标表、revision CAS、持久化证据 UUID、续查接口和带 findings 的正式报告全部删除。理由是这些簿记由模型维护，占用调用预算并拖慢回答，而前端已只展示测点状态。旧表与旧数据保留在数据库中，不再读写，迁移不删除。

- 数据层 `app/monitoring_data.py`：模型工具和测点页共用测点解析、按固定日历块分片取数（小时 30 天、每日固定时刻 360 天）、上游并发 4、观测清洗和质量统计。同一会话的数据块缓存 10 分钟，追问和重叠窗口不重复请求；缓存不是事实来源，过期即重读。运行结束关闭连接，缓存保留。
- 工具按意图组织：find_stations、get_displacement（序列与各方向特征合一，可分段、可同组共同时段对比，点数少时附逐点相对位移）、query_weather（历史最多 366 天，可选逐小时降水，预报按需）、analyze_gnss_chart（候选在已取得的小时数据上复核，不再回查平台）、inspect_site_environment、compute、update_plan、record_conclusions，以及有存储时的 get_station_history。基准站由工具直接说明，不生成失败卡片；窗口过长等可修正问题作为参数纠错返回模型。
- compute 在子进程中执行模型写的 pandas/numpy 代码，输入只来自本会话依据：语法树白名单（禁止导入、下划线属性和文件/网络入口）、受限内置函数、`python -I`、超时，Linux 上另有内存和 CPU 上限。这能挡住常见误用和注入，不等同于操作系统级沙箱；单人自托管下可接受，多用户前需复核。计算结果是 computation 依据，可被引用和再次计算；代码保存在依据中，界面不展示。
- 依据产物：位移统一为 gnss_series（含 features/comparisons/reference/quality/location），删除 numerical；新增 computation、plan、conclusions。plan 与 conclusions 不是可引用依据。
- 结论登记只校验可确定的条件（测点有依据、数据型状态有覆盖窗口的位移数据），依据自动关联本会话中该测点的全部依据，与测点结论索引同事务写入。测点调查记录在 Agent 收尾按本轮涉及的测点写入，锚点是用户提问消息。
- 存证与恢复沿用下节机制，模型不再看到存证 UUID。

## 2026-11-11 存证事务（仍有效部分）

观测在所有入口共用排序、重复时间剔除、非有限值清洗及请求采样日历；固定参考累计值与窗口净变化分开。单站全窗、方向独立的共同有效样本、分窗与事件区间显式标注。

EvidenceMiddleware 在工具完成边界幂等存证，执行键包含模型消息 ID 与工具调用 ID；SSE 只传递结果，不负责存证。短写入有超时及取消保护，恢复核对官方 checkpoint 与证据表并补全，不重放已完成取数，也不增加第二份会话历史。

## 2026-11-12（续）删除视觉复核与调查计划，地图改用天地图

- 删除 analyze_gnss_chart（看图找候选再数值复核）和 update_plan。台阶、趋势转折已由 get_displacement 的数值特征给出（发生时刻、幅度、维持或回落），看图结果重复且慢；计划与调查过程展示重复，还多占一次模型调用。相关配置（VISION_*）、matplotlib 依赖和前端卡片一并删除；旧会话中的这两类工具结果按未知工具显示为一般步骤，不做兼容渲染。
- 时间轴与依据卡片默认展示累计位移（相对平台固定参考），缺参考的方向退回窗口首点并在图上说明；台阶以曲线上的标记呈现。日降雨画成整日色块，避免与 15:00 等采样时刻错位。
- 地图使用高德 JavaScript API 2.0（路网、卫星影像及路网注记），密钥由后端 AMAP_TOKEN 运行时下发（/map-config）；未配置时提示并保留场地资料。仅在展示边界用 gcoord 将 WGS84 测点和 Macrostrat 地质几何转为 GCJ-02，原始数据与环境查询坐标不改写。非法坐标不绘制、不自动交换经纬度。Macrostrat 区域矢量瓦片由官方 @mapbox/vector-tile / pbf 解码，在高德 CustomLayer 中绘制；地层默认关闭，构造线在视野内无收录时给出说明。
- 会话改名不再要求会话空闲：标题在首条消息运行期间生成并写回，此前被 409 拒绝导致会话名一直是“新会话”。归档仍需等运行结束。

## 2026-11-13 地图聚焦卫星影像与移动端调查

- 用户反馈手机地图不能滑动，原因为两张地图仅对精细指针启用拖动。统一开启平移与触屏缩放，地图区域接收触摸手势，区域外仍可滚动页面；关闭旋转，保证位移箭头与正北方向一致。
- 两张地图默认卫星图，可切换普通地图。用户确认区域地层和构造线叠加无助于当前调查，移除前端叠加层、开关、瓦片请求及专用依赖；已取得的场地环境文字资料仍可查阅。此决定替代上节对区域图层的展示约定。
- 站点类型来自既有测点资料。基准站保留位置与身份，不显示位移箭头或方向角；移动站沿用水平位移方向展示，箭头长度为相对示意。
