# 项目状态与有效决策

更新：2026-09-16。只保留当前实现、持续有效的决策及未完成事项。产品行为以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准，待办以 [现行 TODO](TODO_2026-09-15.md) 为准。

## 当前实现

- 后端生产入口 `backend/app/agent/graph.py:graph` 为官方图工厂：create_agent 负责 ReAct 与工具并行执行，官方 middleware 负责模型/工具重试；LMA middleware 保留时间、Prompt、用量/思考耗时及推荐契约；历史由官方 SummarizationMiddleware 管理。持久化仍由 Agent Server Thread/Checkpoint 提供。
- 前端使用官方 `@langchain/react useStream` / StreamController；新会话直接 submit，SDK 分配 ID，Server run.start 创建 Thread 与 Run。URL 仅保存选择态，消息/checkpoint 由 SDK 恢复。手工预创建、重复草稿状态和聚合 `isGenerating` 已删除；Thread hydration、Run、Tool 与 optimistic message 分别读取官方投影，仅 Stop 后 checkpoint 清理保留本地过渡态。
- 第一阶段 TODO 1–3 已完成：遗留界面与无引用组件清理；敏感示例替换；GNSS 缺测不转成 0；消息只显示服务端时间且按 Asia/Shanghai 展示；站点未知状态不猜测；配置检查精确验证 lma-agent；内部字段默认折叠；正式 Prompt 单一来源。
- 2026-09-15 TODO 4 已完成生产代码入口迁移，langchain==1.3.18 已纳入运行依赖，删除手写路由、循环边、ToolNode 装配及节点级批量 retry/exhausted。旧候选 factory 与候选测试已在 TODO 5 清除；架构和部署要求见 [ADR 0001](adr/0001-agent-runtime.md)。本轮未对现有服务执行部署。

## 持续有效的决定

- TODO 11 已完成：官方 metadata.graph_id 过滤与20条offset分页；服务端 updated_at 排序，标题完成后不永久置顶。空闲时无列表轮询，只刷新已知busy IDs；事件刷新已加载范围，分页失败不推进offset并保留已确认列表。辅助图即使有标题也不展示，不增加旧会话迁移。
- TODO 12 已完成：Stop 直接调用官方 `stream.stop({ cancel: true })` 中断当前 Run；服务端未完成工具调用清理检查最终 checkpoint 中全部 AI tool-call 消息，用官方 RemoveMessage 实例清理，并行部分完成时原位保留成功 calls/ToolMessages。删除 cancelled ToolMessage、cancelled UI、asNode="tools"、Run 扫描/批量取消与 resume；下一条用户消息普通 submit 新 Run。
- TODO 13 已完成：状态完全对齐官方生命周期：hydration/Run 分别使用 `stream.isThreadLoading`/`stream.isLoading`，工具运行使用 `useToolCalls`，用户消息 pending/sent/failed 使用 `useMessageMetadata`。`stopReconciling` 为 LMA 唯一本地过渡态（结合 ref 同步锁），收尾期间禁止切会话。
- TODO 14 已完全收口（2026-09-17 减法重构完成）：彻底移除全局 `submissionError`，错误严格按产生它的交互层级归属：
  - 用户消息发送失败就地通过 `OptimisticMessageStatus` 提供“重试”，重试时直接复用 `stream.messages` 中原 `BaseMessage` 实例，复用原 ID 避免并发重复，不设“丢弃”按钮；若末尾用户消息为 optimistic failed 则 `RunFailureCard` 不重复展示；
  - 主 Run 失败卡显示在 assistant 回答位置，由单次提交的 `submit.onError` 判定，删除多余的 `reconcileRunError()` 状态机二次推断；支持官方分叉重生成：通过公开 `useMessageMetadata` 提取 `parentCheckpointId`，分叉时重新输入原 Human 消息；
  - 工具错误限制在单工具卡内；
  - Thread 重命名/删除使用独立 Toast 浮层；
  - Stop 收尾为短时原子交互，期间禁止切换会话；清理失败阻塞后续发送，提示条收拢为“停止处理未完成 · 重试”（无关闭按钮，仅可重试），成功前当前 Thread 不允许继续提问；
  - 彻底删除 `activeSubmissionRef.stopped` 与手工拦截，信任官方 abort 行为不入 `onError`；`activeSubmissionRef` 仅用于新会话首条消息回写 SDK 铸造的 `threadId`；
  - 连接状态与辅助能力：删除全局冗余探活，列表错误严格局限在 Sidebar；标题生成与下一步建议失败静默降级；
  - 状态扁平化：`runError`、`hydrationError`、`stopError` 统一收敛为当前会话单布尔瞬态，切换会话自动重置；
  - ErrorBoundary 隐藏内部堆栈并提供真实刷新/重新加载/隐藏动作。绝不展示内部异常、堆栈、HTTP 或 checkpoint 诊断。

- TODO 10 已完成：URL 驱动 Sidebar 与 Stream 选择；切换/新建新增导航记录，SDK 分配 ID、删除当前 Thread 与连接切换替换当前记录；popstate 断开旧订阅后由 SDK 恢复目标会话，不停止服务端 Run。不改写旧导航记录，不为不存在的 Thread 自动选择其他会话。

- 主 Agent 根据目标与证据自主编排；禁止固定调查顺序、章节和模板化建议。业务/视觉策略分别只编辑 `system.md` / `vision.md`。
- 推荐仅基于完整最终回答；保留 RECOMMEND_ENABLED 与 RECOMMEND_THINKING，不恢复固定字数触发的流式预取。不合适时可为空，失败静默降级不干扰主流程。
- LLM_THINKING 仅控制主模型；标题、推荐、压缩和视觉有独立开关，默认关闭。当前供应商 reasoning 适配仍在，标准化迁移属于 TODO 16–17；不得拼造思考内容。
- TODO 5 已替换旧压缩算法：官方摘要消息为 checkpoint 中唯一摘要来源；按官方token阈值触发和token budget保留，按lc_source标记投影。摘要使用当前 LLM 配置与独立思考开关，失败显式终止本次请求，历史不被删除。
- TODO 6 已统一六个工具的官方 content/artifact/status 协议和请求前 Pydantic 校验。参数、业务、基础设施及内部错误区分；失败原因常驻，部分证据可查看。模型只读事实，前端只消费展示 artifact，不解析 content、不暴露通用 JSON；原始诊断只写后端日志，artifact 不能放秘密。
- TODO 7 已统一官方调用级重试与Run级模型/工具限额：默认重试2次、模型20次、工具40次、视觉有效候选12个；只有瞬时异常可重试，混合失败组不盲重试。全部底层SDK关闭重试，删除视觉格式/空结果与降载重试；超额明确报错并保留已有证据。摘要仍沿用官方独立逻辑；调用限额不是全HTTP或耗时配额。
- TODO 8：onThreadId 写 URL 并立即显示 skeleton，用户输入使用 SDK optimistic messages；onCreated(runId) 异步启动标题，不等待 Agent。标题成功/失败保存 metadata 后原位显示标题/“新会话”，不影响聊天；metadata 保存失败明确显示未保存。Run 结束只取消运行 loading，轮询不吞骨架、不改选择态。
- 地图弹窗通过 textContent 构造，瓦片源为受信代码配置；外部数据保留来源与坐标信息。Macrostrat 不能可靠提供最近断层距离，应明确缺失。
- 当前不建设内部用户管理；部署认证、访问控制与生产 Server 暴露边界仍待 TODO 25。镜像构建通过 .dockerignore 排除环境文件和本地开发内容。

## 未完成与验证边界

- 2026-09-17 TODO 14 减法重构与完全收口：
  - 移除二次解释 runtime：彻底删除过度防御的四阶段状态机（`terminal_confirm`）、`runs.list/get/cancel/join`、二次 cancel 轮询、`handleCleanupAfterStop`、`handleRefreshStop`、`reconcileRunError()`。Stop 直接信任 `stream.stop({ cancel: true })` $\to$ `removeIncompleteToolCallMessages` $\to$ `rehydrateThread`；
  - 消息重试回归官方原语：optimistic 失败重试直接从 `stream.messages` 中提取原 `BaseMessage` 提交，复用原 ID 避免重复消息气泡；
  - Stop 收尾原子化：`stopReconciling` 期间 Sidebar 禁用且阻止切换会话；清理失败阻塞提问，统一文案“停止处理未完成 · 重试”（无关闭按钮，仅可重试）；
  - 移除 `activeSubmissionRef.stopped` 与过时测试，信任官方 abort 机制；
  - 状态扁平化：`runError`、`hydrationError`、`stopError` 为单会话布尔瞬态，`stopReconciling` 为单布尔态结合同步 ref 锁；
  - 验证：前端 75 项测试全数通过，生产构建通过，后端常规 51 项（49 项通过、2 项 Server E2E 默认跳过）全数通过，`git diff --check` 无违规。
- TODO 9–14 已完成唯一 Client / Transport、URL 生命周期、列表归属/增量加载、Stop 清理协议、官方生命周期投影及分层错误交互模型；下一项为 TODO 15 移除自定义 Message/Tool 状态机（优先清理自定义 runtime 与推断，后按需评估组件拆分）；推荐退出主 Run 属于 TODO 23。

## 2026-09-15 TODO 9：统一 Client 与连接切换边界

- App 通过官方 client 注入共用稳定 SDK 实例；Thread CRUD、标题及现有停止辅助请求不再独立创建连接或隐式读取 localStorage。主 Assistant identity 与 HTTP 策略集中定义，认证 header 统一由工厂注入；未新增认证 UI/存储。
- 未保存地址的连通性测试只访问 Assistant；保存新服务地址会清空旧服务选择和展示态、作废旧请求回写，不迁移/删除历史。标题输出校验、纯文本展示与 SDK HTTP 零重试保留。
- 本轮前端41项测试和生产构建通过；后端常规发现51项，49项通过、2项隔离Server E2E按默认条件跳过。本项未改后端、未部署、未操作真实会话。下一项 TODO 10；停止协议留给 TODO 12。

## 2026-09-15 用户纠正：直接替换，不保留兼容代码

用户明确要求保证当前新实现可运行，并持续移除历史包袱。重构不保留旧 checkpoint、字段、API 或旧算法兼容分支，也不为旧会话增加自动迁移。该规则已写入 AGENTS.md。本轮直接删除旧摘要状态、淘汰算法、相关配置及候选实现，未删除用户历史数据。

历史上被撤回的推荐预取、旧 TODO 编号实施方案和已被替代的流式补丁说明已清除。未来不得从这些旧方案恢复兼容逻辑；新增兜底继续按 AGENTS.md 告知与审批边界执行。

## 2026-09-15 用户纠正：摘要触发与保留全部走官方 token 逻辑

压缩按 token 阈值触发，近期上下文按 token budget 保留。已删除 LmaSummarizationMiddleware、完整回合下限、消息数保留、切点覆写和私有摘要重试/空值检查，直接使用官方 trigger/keep 和默认 token 计数器。CONTEXT_KEEP_TOKENS 替代消息数/回合配置，CONTEXT_COMPRESS_RATIO 已移除。不要再次添加固定回合或自定义压缩决策。

## 2026-09-15 用户纠正：标题从 onCreated 启动，与主 Run 独立

上一实现把标题推迟到首个 Run 结束，并移除了骨架，不符合交互意图。新建中央空白且不预建 Thread；onThreadId 后立即插入骨架并由 SDK 乐观显示输入；onCreated 后异步启动标题。主 Run 结束仅取消 sidebar 运行 loading，不收尾标题。该时序已同步 AGENTS.md、PRD 和 TODO，并用两种完成顺序及迟到回调测试约束。

## 2026-09-15 删除会话失败排查

容器日志显示同一 Thread 先 DELETE 204、约两秒后再次 DELETE 404。已复现旧轮询可恢复已删除条目，但不能仅凭重复 Thread ID 将本次问题归因为用户重复点击。用户确认连续删除的是不同会话；浏览器控制台证实报错位于 SDK HTTP DELETE 404。SDK 网络自动重试是另一个重复请求路径，最初重发原因尚无完整网络证据。现使用 useStream.client 的官方 threads.delete：删除前断开当前订阅；请求期间暂停轮询写回并禁止重复操作；成功后使旧请求失效、按最新状态移除条目，并取消对应标题展示任务。404 明确提示会话已不存在并重新同步列表，409 提示停止运行后删除；其他失败保留已确认状态，内部诊断只写控制台。回归覆盖旧轮询、重复点击、204、404、409；不把 404 转成删除成功，不删除用户历史作排查测试。

用户纠正后补充：SDK HTTP maxRetries 固定为0，复用稳定配置对象，防止一次有副作用请求因网络错误自动重发；不影响后端官方模型/工具重试。删除控制台记录目标Thread ID、确认结果和失败阶段；不将请求日志中的重复ID解释为用户重复点击。连续删除不同Thread与网络异常不重发由回归约束，未删除用户真实会话来复现。

## 2026-09-16 TODO 10：URL 会话导航验收

- 直接链接与重新挂载不被列表首项或空列表覆盖；真实 history.back/forward 测试验证选择与 SDK ID 同步，重复选择不增加导航记录，其他 query/hash 保留。现有删除成功与新建测试验证 URL 清理。PRD 与 TODO 已同步。
- 前端43项测试、生产构建通过；后端常规51项测试，49项通过、2项隔离Server E2E默认跳过。本项未改后端、未部署或操作真实历史。浏览器及线上全面 E2E仍待后续验收。下一项 TODO 11，本轮按清单只处理一个复杂事项。

## 2026-09-17 时间与 Prompt Cache 重构

- `system.md` 彻底静态化，移除 `{{CURRENT_TIME}}` 与业务时区硬编码；时间范围与气象日期格式等客观规则写入静态提示词。
- 新增 `get_current_time` 工具，唯一返回服务器当前业务时间与时区（Asia/Shanghai），支持 content 与 artifact 契约。智能体在需要确认当前时间或推导相对日期时主动调用该工具。
- `create_agent` 直接使用官方 `system_prompt=SYSTEM_PROMPT` 参数；移除 `awrap_model_call` 中动态 `SystemMessage` override，使主模型提示词与第一条系统消息在所有请求中彻底固定，最大化供应商 Prompt Cache 命中率。
- `recommendation` 移除 `build_time_context` 动态注入；`AgentState` 彻底删除无其他用途的 `business_time` 字段，前端 `LmaState` 同步删除该属性。
- 彻底移除 `_resolve_time`、`build_time_context`、`build_system_prompt` 及旧动态模板测试；更新回归测试并补齐 `get_current_time` 同步/异步/Agent 运行断言。
- 验证：后端 52 项测试全部通过（2 项隔离 E2E 跳过），前端 75 项测试全部通过，前端生产构建通过，`git diff --check` 无违规。
