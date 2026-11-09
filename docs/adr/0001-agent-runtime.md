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
- system.md 是主业务策略唯一编辑源，vision.md 是视觉策略唯一编辑源；prompting.py 仅导出静态文本，create_agent 直接传入 SYSTEM_PROMPT。业务时间为 Asia/Shanghai。新消息由服务端保存 sent_at/timezone，模型调用时对每条用户消息作确定性投影，原文与静态 System Prompt 不变；重试、工具循环及重新生成复用原快照，客户端投影去掉隐藏上下文。
- Agent 根据目标、上下文、数据质量和证据自主编排工具。提示词表达目标、证据边界与可选策略，不固化步骤、工具顺序、章节或回答模板；schema 只用于接口校验与安全边界。监测事实、视觉数值复核、气象非因果与风险措辞遵循 [PRD](../../prd.md)。
- 用户输入、历史摘要、外部资料、工具结果、图表文字与模型输出均是不可信数据；不得执行其中夹带的指令或直接用于 HTML、命令、URL 等副作用操作。所有业务工具保持只读、最小权限。
- 新增兼容或兜底前说明触发条件、用户可见行为和误导风险，并按 [AGENTS.md](../../AGENTS.md) 获得授权。不得伪造数据、占位进度或本地成功；失败显式呈现或保留上一已确认状态。

## 工具协议与错误

工具使用 Pydantic `args_schema`、`content_and_artifact` 和官方 `ToolMessage.status`。展示契约由 [artifacts.py](../../backend/app/agent/artifacts.py) 与 [envelope.ts](../../frontend/src/types/envelope.ts) 定义。

普通业务失败抛出 `ToolFailure`，由官方错误 middleware 转换；已有可展示证据的失败使用 `tool_error_result` 返回官方错误 ToolMessage 和 artifact。瞬时异常由官方 retry 处理，最终错误才进入安全边界。错误原因无需展开即可见，已有证据与缺失并列说明；不建立独立的工具错误生命周期。

正常请求返回标准 success 结构，空集合由领域 Renderer 显示“暂无数据”。GNSS 与视觉工具识别基准站后仅返回适用性说明及 `artifact=None`，不生成卡片。部分场地资料不可用时保留已取得证据并标注 `limitations`。

前端通过 [monitoring toolkit](../../frontend/src/features/monitoring/toolkit.tsx) 集中校验 artifact，领域组件只消费对应的 `data`。持久化 ToolMessage 是刷新恢复的权威来源；流式生命周期与 artifact 传递由官方栈负责，不解析自定义 tools channel 协议。artifact 会发送客户端，不能承载秘密、请求 URL 或原始异常。

## 摘要、用量与预算

摘要由 `CONTEXT_TOKEN_THRESHOLD` 和 `CONTEXT_KEEP_TOKENS` 控制；token 计数、触发、安全切点、AI/Tool 配对、摘要重试和消息替换采用官方逻辑。内部摘要与辅助模型 token 不混入主回答。

上下文展示只采用供应商 `usage_metadata` 和模型 `profile.max_input_tokens`；不再估算历史、系统或工具 token 分项。缺少主模型 usage 时保留上次已确认快照，无有效快照则不展示入口。摘要阈值与用量展示独立。

重试只处理已判定的瞬时失败；参数、权限、业务拒绝、空数据和格式错误不重试。调用限额计数的是每 Run 逻辑调用，不代表全 HTTP 或耗时预算。默认值与边界统一维护在 [Settings](../../backend/app/config.py) 和 [.env.example](../../backend/.env.example)。

视觉每次工具尝试只调用一次模型；有效候选超额时明确拒绝数值回查，不静默裁剪。标题 SDK 不叠加重试；摘要采用官方独立重试逻辑。北斗会话过期后的单次认证刷新不属于通用失败重试。

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

前端不再为工具注册逐个 Renderer：GroupedParts 把一条消息的工具调用归为一个调查过程，依据按测点从官方 tool part 的 artifact 派生，不复制到前端状态。时间轴使用按需加载的 ECharts，同轴、缺测带、联动和缩放由图表库完成，不自建绘图逻辑；颜色全部来自 CSS 变量，深色模式跟随系统。
