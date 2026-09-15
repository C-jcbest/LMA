# ADR 0001：主 Agent 采用 create_agent + middleware

- 日期：2026-09-15
- 状态：已实施（TODO 4 完成）；现有服务未部署

主 Agent 是通用 ReAct 循环，没有多分支业务流程、并行汇合或专用多 Agent，故采用 LangChain 官方 create_agent；不能以旧代码已使用 StateGraph 为理由维护通用 plumbing。langchain==1.3.18 与当前 core==1.6.2 / langgraph==1.2.11 匹配，已加入运行依赖。

## 职责与实现

生产唯一工厂是 `backend/app/agent/graph.py:create_lma_agent`，`graph(config)` 按 Agent Server 图工厂协议返回 CompiledStateGraph，不自行安装 checkpointer。模型延迟构建，工具绑定由官方 Runtime 完成。

| 职责 | 采用实现 |
| --- | --- |
| ReAct model/tools 路由、标准消息与工具并行 | create_agent；删除 route_after_agent、手写循环边及 ToolNode 装配 |
| 模型重试 | ModelRetryMiddleware；主模型底层 max_retries=0，避免重复计数 |
| 工具重试 | ToolRetryMiddleware；仅重试失败调用，删除节点级批量 retry / exhausted 补齐 |
| 瞬时异常分类 | 已有 httpx 分类及 OpenAI APIConnectionError / APIStatusError；参数、权限失败不重试 |
| 受控失败内容 | 官方工具 retry on_failure + LMA wrap_tool_call；ToolMessage status=error，原始异常仅记录日志，GraphBubbleUp 不吞掉 |
| 回合时间、清空旧推荐 | LMA before_agent，一次 Run 共享服务端时间锚点 |
| 动态 Prompt、消息时间与思考耗时 | LMA wrap_model_call，复用唯一正式 Prompt，保留标准 blocks 和 usage_metadata |
| 实际 context_usage | LMA after_model，供应商未返回 usage 时保留上一已确认值 |
| 完整最终回答后的推荐 | LMA after_agent；独立思考配置与失败字段保留，辅助 token 不混入主消息流 |
| Thread/Checkpoint | Agent Server 注入，未新增数据库、迁移兜底或第二套历史 |

TODO 5 已采用官方 SummarizationMiddleware，删除旧算法和 context_summary。LMA 子类仅向前限制官方安全切点，保留近期完整用户回合；不实现摘要/淘汰/替换状态机。必要 summary prompt 在 prompts/summary.md 中维护证据边界，前端按官方 lc_source 标记过滤摘要气泡并投影摘要卡。内部调用使用官方 nostream 标记、非流式 ChatOpenAI 和官方 with_retry，重试仅接受明确瞬时异常；空摘要抛错，不删除历史。

CONTEXT_KEEP_MESSAGES 替代旧 CONTEXT_TARGET_RATIO；删除 COMPRESS_MODEL / COMPRESS_BASE_URL / COMPRESS_API_KEY 的可选复用分支，摘要直接使用当前模型配置并保留独立 COMPRESS_THINKING。输出上限通过模型参数控制，官方摘要输入不再采用4000token裁剪，防止遗漏被压缩的监测事实。Factory 根据当前 Prompt、工具 schema、输出/安全预留计算历史触发预算。

推荐退出主 Run 仍属 TODO 23，当前 after_agent 保留功能；调用预算由 TODO 21 单独确定。

## 验证证据

- `test_agent_runtime.py`：生产工厂的模型/工具循环、并行工具部分失败、单工具重试耗尽、非瞬时错误、interrupt 传播、多轮持久化、时间、usage/思考耗时与推荐开关。
- `test_agent_server_runtime.py`：真正启动隔离 langgraph dev，使用生产 graph 工厂与 HTTP OpenAI-compatible / 北斗 Stub；SDK stream 取得模型消息和工具 updates，模型和工具 503 重试通过，新客户端恢复 Thread 并完成第二轮。测试在临时目录运行，不读取项目 .env 或改写已有服务。
- 显式执行：PowerShell 在 backend 下设置 `$env:LMA_RUN_SERVER_E2E='1'`，运行 `.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_agent_server_runtime.py -v`。默认常规测试不启动服务。
- 当前后端35项常规测试、1项隔离Server E2E、前端16项会话测试及生产构建通过。浏览器全面 E2E、真实模型和线上北斗服务不是本轮完成证据。

旧候选 factory 与旧压缩测试已删除。生产回归统一使用 create_lma_agent。test_context_management.py 验证官方摘要和 LMA 保留边界；Server E2E 还实际触发摘要与摘要503重试，确认内部 token 不混入主消息流，压缩后的 Thread 与主模型 usage 正常恢复。

## 部署与历史边界（2026-09-15 更新）

用户明确要求不保留兼容代码，后续只保证当前新实现运行。新图不读取旧 context_summary，不兼容旧节点上暂停的 Run，也不自动迁移 checkpoint、补造历史摘要或删除用户历史。部署验收使用新 Thread；已有历史是否可继续不作为本轮契约。本轮未对现有服务执行部署或历史数据改写。

## 官方参考

- [Agents](https://docs.langchain.com/oss/python/langchain/agents)
- [Custom middleware 与 hook 顺序](https://docs.langchain.com/oss/python/langchain/middleware/custom)
- [Prebuilt middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in)

以锁定版本本地类型、源码和实际 Agent Server 测试确认 API 行为。
