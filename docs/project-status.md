# 项目状态与有效决策

更新：2026-09-16。只保留当前实现、持续有效的决策及未完成事项。产品行为以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准，待办以 [现行 TODO](TODO_2026-09-15.md) 为准。

## 当前实现

- 后端生产入口 `backend/app/agent/graph.py:graph` 为官方图工厂：create_agent 负责 ReAct 与工具并行执行，官方 middleware 负责模型/工具重试；LMA middleware 保留时间、Prompt、用量/思考耗时及推荐契约；历史由官方 SummarizationMiddleware 管理。持久化仍由 Agent Server Thread/Checkpoint 提供。
- 前端使用官方 `@langchain/react useStream` / StreamController；新会话直接 submit，SDK 分配 ID，Server run.start 创建 Thread 与 Run。URL 仅保存选择态，消息/checkpoint 由 SDK 恢复。手工预创建、重复草稿状态和聚合 `isGenerating` 已删除；Thread hydration、Run、Tool 与 optimistic message 分别读取官方投影，仅 Stop 后 checkpoint 清理保留本地过渡态。
- 第一阶段 TODO 1–3 已完成：遗留界面与无引用组件清理；敏感示例替换；GNSS 缺测不转成 0；消息只显示服务端时间且按 Asia/Shanghai 展示；站点未知状态不猜测；配置检查精确验证 lma-agent；内部字段默认折叠；正式 Prompt 单一来源。
- 2026-09-15 TODO 4 已完成生产代码入口迁移，langchain==1.3.18 已纳入运行依赖，删除手写路由、循环边、ToolNode 装配及节点级批量 retry/exhausted。旧候选 factory 与候选测试已在 TODO 5 清除；架构和部署要求见 [ADR 0001](adr/0001-agent-runtime.md)。本轮未对现有服务执行部署。

## 持续有效的决定

- TODO 11 已完成：官方 metadata.graph_id 过滤与20条offset分页；服务端 updated_at 排序，标题完成后不永久置顶。空闲时无列表轮询，只刷新已知busy IDs；事件刷新已加载范围，分页失败不推进offset并保留已确认列表。辅助图即使有标题也不展示，不增加旧会话迁移。
- TODO 12 已按用户纠正完成：Stop 仅 interrupt 当前 Run，等待该 Run 收敛后读取最终 checkpoint；全未完成 AI tool-call 消息用 RemoveMessage 删除，并行部分完成时原位保留成功 calls/ToolMessages。删除 cancelled ToolMessage、cancelled UI、asNode="tools"、Run扫描/批量取消和 resume；下一条用户消息普通 submit 新 Run。rollback 会回退整轮，不用于“仅丢弃未完成部分”。
- TODO 13 已完成：删除聚合 `isGenerating` 和 `isStartingRun`；hydration/Run 分别使用 `stream.isThreadLoading`/`stream.isLoading`，工具运行使用 `useToolCalls`，用户消息 pending/sent/failed 使用 `useMessageMetadata`。仅 `stopReconciling` 为 LMA 本地过渡态，清理时可输入但不可发送。Run ID 从产生 Run 的 submission 关联，不从当前 UI 选择推断；Sidebar busy 与中央 Run 状态分离。

- TODO 10 已完成：URL 驱动 Sidebar 与 Stream 选择；切换/新建新增导航记录，SDK 分配 ID、删除当前 Thread 与连接切换替换当前记录；popstate 断开旧订阅后由 SDK 恢复目标会话，不停止服务端 Run。不改写旧导航记录，不为不存在的 Thread 自动选择其他会话。

- 主 Agent 根据目标与证据自主编排；禁止固定调查顺序、章节和模板化建议。业务/视觉策略分别只编辑 `system.md` / `vision.md`。
- 推荐仅基于完整最终回答；保留 RECOMMEND_ENABLED 与 RECOMMEND_THINKING，不恢复固定字数触发的流式预取。不合适时可为空，失败显式呈现。
- LLM_THINKING 仅控制主模型；标题、推荐、压缩和视觉有独立开关，默认关闭。当前供应商 reasoning 适配仍在，标准化迁移属于 TODO 16–17；不得拼造思考内容。
- TODO 5 已替换旧压缩算法：官方摘要消息为 checkpoint 中唯一摘要来源；按官方token阈值触发和token budget保留，按lc_source标记投影。摘要使用当前 LLM 配置与独立思考开关，失败显式终止本次请求，历史不被删除。
- TODO 6 已统一六个工具的官方 content/artifact/status 协议和请求前 Pydantic 校验。参数、业务、基础设施及内部错误区分；失败原因常驻，部分证据可查看。模型只读事实，前端只消费展示 artifact，不解析 content、不暴露通用 JSON；原始诊断只写后端日志，artifact 不能放秘密。
- TODO 7 已统一官方调用级重试与Run级模型/工具限额：默认重试2次、模型20次、工具40次、视觉有效候选12个；只有瞬时异常可重试，混合失败组不盲重试。全部底层SDK关闭重试，删除视觉格式/空结果与降载重试；超额明确报错并保留已有证据。摘要仍沿用官方独立逻辑；调用限额不是全HTTP或耗时配额。
- TODO 8：onThreadId 写 URL 并立即显示 skeleton，用户输入使用 SDK optimistic messages；onCreated(runId) 异步启动标题，不等待 Agent。标题成功/失败保存 metadata 后原位显示标题/“新会话”，不影响聊天；metadata 保存失败明确显示未保存。Run 结束只取消运行 loading，轮询不吞骨架、不改选择态。
- 地图弹窗通过 textContent 构造，瓦片源为受信代码配置；外部数据保留来源与坐标信息。Macrostrat 不能可靠提供最近断层距离，应明确缺失。
- 当前不建设内部用户管理；部署认证、访问控制与生产 Server 暴露边界仍待 TODO 25。镜像构建通过 .dockerignore 排除环境文件和本地开发内容。

## 未完成与验证边界

- 2026-09-16 TODO 12：用户纠正原“补隐藏 cancelled ToolMessage”方案，要求未完成工具从 messages 删除。实现保留成功 ToolMessage；全未完成删除 AIMessage，部分完成收窄 AIMessage，保证下一轮消息协议有效。锁定版 React SDK 没有公开的外部 updateState 刷新入口，当前使用导出的内部 STREAM_CONTROLLER.hydrate 作最窄适配；仅在清理成功后触发，不伪造状态，TODO 15 或 SDK 提供公开入口时删除。真实 Agent Server 已验证 RemoveMessage；完整浏览器 E2E 尚未执行。
- TODO 12 验证：前端55项测试与生产构建通过；后端常规51项中49项通过、2项Server E2E默认跳过。覆盖思考阶段、单批/多批未完成、失败重试追加 HumanMessage、并行部分完成、严格相邻配对、全部完成、重复Stop、清理失败、权威重载和下一条普通submit。为恢复本次受影响会话，已删除确认无 ToolMessage 的 AI 工具调用消息并读回验证。
- 2026-09-16 Stop 线上纠正：首次真实操作证明 Agent Server 0.14.1 不接受远程 updateState 中的简写 `{type:"remove", id}`，返回 MESSAGE_COERCION_FAILURE；必须发送 LangChain RemoveMessage/AIMessage 实例，由 SDK 序列化为 lc constructor。已恢复官方实例并增加真实 SDK wire-format 回归。失败会话中确认的1条全未完成 AIMessage 已重新清理并读回验证，其他消息未删除；临时协议测试 Thread 已删除。错误日志现记录 stop/join/cleanup/hydrate 阶段，UI按实际阶段说明。此前“未修改真实会话”的记录被本条取代。
- 2026-09-16 Stop 重试纠正：清理范围曾被错误限制为最后一个 HumanMessage 之后。清理首次失败后，普通重试先写入新的 HumanMessage，导致之前残留的 AI tool-call 消息被遮蔽，模型接口以“tool_calls 后缺少 tool messages”拒绝新 Run。现改为检查最终 checkpoint 中全部 AI tool-call 消息，并只把紧随 AIMessage 的连续 ToolMessage 视为有效配对；未来不得重新按最后用户回合截断。已从受影响会话删除1条含3个未回答 calls 的 AIMessage，消息数由20变为19，读回确认未配对 AI tool-call 消息为0，已有成功 ToolMessage 保留。前端55项测试与生产构建通过。
- 2026-09-16 Stop 后继续纠正：真实时序为工具已完成、总结前 interrupt，随后普通 submit“继续”。服务端新 Run 最终 success 并写入完整总结，但前端旧提交迟到错误或流异常会显示通用失败，且流态可能暂时缺少新 HumanMessage 边界，使新输出看似接在取消前工具后。现给提交记录 stop/runId/threadId 归属：主动 Stop 的迟到错误静默丢弃；流异常只等待已确认的同一 Run，success 后 hydrate，error 才展示失败，不重试或另建 Run。投影回归固定旧工具结果、继续消息和新 AI 回复的独立顺序。实现后前端58项测试与生产构建通过。
- 2026-09-16 TODO 13 状态纠正：此前 `isGenerating` 聚合 hydration、Run、Stop reconciliation 与本地 starting，导致加载历史也显示 Stop/思考，Stop 清理期间无法提前输入。现直接消费官方 Stream/Tool/Message 生命周期，只保留 `stopReconciling`；optimistic failed 已接通但 Retry/错误位置按范围留给 TODO 14，完整工具/消息 renderer 留给 TODO 15。前端63项测试与生产构建通过。
- 2026-09-16 TODO 11：前端47项测试、生产构建通过；后端51项中49项通过，2项Server E2E默认跳过。105条分页由真实SDK/HTTP Stub验证，界面覆盖分页失败、去重、busy结束、空闲无轮询及迟到请求隔离。未部署、未修改真实历史、未执行真实浏览器E2E；其后已完成TODO 12。

- TODO 5 的生产测试覆盖长会话摘要、近期token budget保留、重复压缩、停止后工具配对、摘要失败保全和内部模型流隔离。Server E2E 使用真实生产工厂与 HTTP Stub 验证官方摘要、瞬时重试、Thread 恢复及主 usage 保留。
- 本轮后端49项常规测试、2项隔离Server E2E、前端39项测试和生产构建通过（常规发现51项，服务E2E默认跳过并另行执行）。真实官方 React SDK 测试覆盖首次 run.start 拒绝，隔离服务覆盖新版协议首次创建与 checkpoint；详细命令见 ADR。浏览器全面 E2E、真实模型/线上北斗仍属后续验收。当前服务未部署，历史会话未改写。
- TODO 9–13 已完成唯一 Client / Transport、URL 生命周期、列表归属/增量加载、Stop 清理协议及官方生命周期投影；下一项为 TODO 14 分层错误模型；推荐退出主 Run 属于 TODO 23。

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
