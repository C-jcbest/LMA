# 项目状态与有效决策

更新：2026-09-15。只保留当前实现、持续有效的决策及未完成事项。产品行为以 `prd.md` 为准，协作与安全约束以 `AGENTS.md` 为准，待办以 [现行 TODO](TODO_2026-09-15.md) 为准。

## 当前实现

- 后端生产入口 `backend/app/agent/graph.py:graph` 为官方图工厂：create_agent 负责 ReAct 与工具并行执行，官方 middleware 负责模型/工具重试；LMA middleware 保留时间、Prompt、用量/思考耗时及推荐契约；历史由官方 SummarizationMiddleware 管理。持久化仍由 Agent Server Thread/Checkpoint 提供。
- 前端使用官方 `@langchain/react useStream` / StreamController；新会话直接 submit，SDK 分配 ID，Server run.start 创建 Thread 与 Run。URL 仅保存选择态，消息/checkpoint 由 SDK 恢复。手工预创建、标题占位与重复草稿状态已删除；Client 统一、URL 完整生命周期与停止协议仍待 TODO 9–13。
- 第一阶段 TODO 1–3 已完成：遗留界面与无引用组件清理；敏感示例替换；GNSS 缺测不转成 0；消息只显示服务端时间且按 Asia/Shanghai 展示；站点未知状态不猜测；配置检查精确验证 lma-agent；内部字段默认折叠；正式 Prompt 单一来源。
- 2026-09-15 TODO 4 已完成生产代码入口迁移，langchain==1.3.18 已纳入运行依赖，删除手写路由、循环边、ToolNode 装配及节点级批量 retry/exhausted。旧候选 factory 与候选测试已在 TODO 5 清除；架构和部署要求见 [ADR 0001](adr/0001-agent-runtime.md)。本轮未对现有服务执行部署。

## 持续有效的决定

- 主 Agent 根据目标与证据自主编排；禁止固定调查顺序、章节和模板化建议。业务/视觉策略分别只编辑 `system.md` / `vision.md`。
- 推荐仅基于完整最终回答；保留 RECOMMEND_ENABLED 与 RECOMMEND_THINKING，不恢复固定字数触发的流式预取。不合适时可为空，失败显式呈现。
- LLM_THINKING 仅控制主模型；标题、推荐、压缩和视觉有独立开关，默认关闭。当前供应商 reasoning 适配仍在，标准化迁移属于 TODO 16–17；不得拼造思考内容。
- TODO 5 已替换旧压缩算法：官方摘要消息为 checkpoint 中唯一摘要来源；按官方token阈值触发和token budget保留，按lc_source标记投影。摘要使用当前 LLM 配置与独立思考开关，失败显式终止本次请求，历史不被删除。
- TODO 6 已统一六个工具的官方 content/artifact/status 协议和请求前 Pydantic 校验。参数、业务、基础设施及内部错误区分；失败原因常驻，部分证据可查看。模型只读事实，前端只消费展示 artifact，不解析 content、不暴露通用 JSON；原始诊断只写后端日志，artifact 不能放秘密。
- TODO 7 已统一官方调用级重试与Run级模型/工具限额：默认重试2次、模型20次、工具40次、视觉有效候选12个；只有瞬时异常可重试，混合失败组不盲重试。全部底层SDK关闭重试，删除视觉格式/空结果与降载重试；超额明确报错并保留已有证据。摘要仍沿用官方独立逻辑；调用限额不是全HTTP或耗时配额。
- TODO 8 的 onThreadId 通知先于服务端确认；仅对有 Run/checkpoint 的首个会话登记默认名，标题在首个 Run 结束后异步生成，失败不污染聊天错误。无名称 Thread 不进入业务列表；结果不确定时不自动删除。标题不覆盖已确认的手动命名。
- 地图弹窗通过 textContent 构造，瓦片源为受信代码配置；外部数据保留来源与坐标信息。Macrostrat 不能可靠提供最近断层距离，应明确缺失。
- 当前不建设内部用户管理；部署认证、访问控制与生产 Server 暴露边界仍待 TODO 25。镜像构建通过 .dockerignore 排除环境文件和本地开发内容。

## 未完成与验证边界

- TODO 5 的生产测试覆盖长会话摘要、近期token budget保留、重复压缩、停止后工具配对、摘要失败保全和内部模型流隔离。Server E2E 使用真实生产工厂与 HTTP Stub 验证官方摘要、瞬时重试、Thread 恢复及主 usage 保留。
- 本轮后端49项常规测试、2项隔离Server E2E、前端27项测试和生产构建通过（常规发现51项，服务E2E默认跳过并另行执行）。真实官方 React SDK 测试覆盖首次 run.start 拒绝，隔离服务覆盖新版协议首次创建与 checkpoint；详细命令见 ADR。浏览器全面 E2E、真实模型/线上北斗仍属后续验收。当前服务未部署，历史会话未改写。
- 下一项为 TODO 9 唯一 Client / Transport 配置源；推荐退出主 Run 属于 TODO 23。

## 2026-09-15 用户纠正：直接替换，不保留兼容代码

用户明确要求保证当前新实现可运行，并持续移除历史包袱。重构不保留旧 checkpoint、字段、API 或旧算法兼容分支，也不为旧会话增加自动迁移。该规则已写入 AGENTS.md。本轮直接删除旧摘要状态、淘汰算法、相关配置及候选实现，未删除用户历史数据。

历史上被撤回的推荐预取、旧 TODO 编号实施方案和已被替代的流式补丁说明已清除。未来不得从这些旧方案恢复兼容逻辑；新增兜底继续按 AGENTS.md 告知与审批边界执行。

## 2026-09-15 用户纠正：摘要触发与保留全部走官方 token 逻辑

压缩按 token 阈值触发，近期上下文按 token budget 保留。已删除 LmaSummarizationMiddleware、完整回合下限、消息数保留、切点覆写和私有摘要重试/空值检查，直接使用官方 trigger/keep 和默认 token 计数器。CONTEXT_KEEP_TOKENS 替代消息数/回合配置，CONTEXT_COMPRESS_RATIO 已移除。不要再次添加固定回合或自定义压缩决策。
