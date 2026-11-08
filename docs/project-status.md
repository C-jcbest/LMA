# 项目状态与有效决策

更新：2026-11-09。本文件只记录当前事实、持续决策和临时例外。实施计划与验收状态见 [TODO.md](TODO.md)，部署操作见 [deployment.md](deployment.md)，产品与协作约束分别以 `prd.md`、`AGENTS.md` 为准。

## 当前事实

- 后端主图使用 LangChain `create_agent`，由 FastAPI 管理会话目录与 Run，官方 PostgreSQL Checkpointer 保存历史；历史摘要、重试、调用限额与工具错误采用官方 Middleware。
- 工具使用 Pydantic 参数和 `content_and_artifact`；前端只展示严格判别的 `artifact.data`，不解析工具 content 或原始 JSON。
- 上下文实际用量只来自供应商 `usage_metadata`，窗口上限只来自模型 `profile.max_input_tokens`；摘要阈值独立配置。
- `system.md`、`vision.md` 是对应策略的唯一编辑源；业务时间统一通过 `get_current_time` 获取，时区为 `Asia/Shanghai`。
- 会话标题由 assistant-ui Adapter 调用`/title` API生成并持久化；下一步建议保留在主 Run，日志记录正文完成、terminal ready 和推荐阶段耗时。
- 前端只有一条 assistant-ui -> react-langgraph 官方 Runtime -> FastAPI SSE -> LangGraph OSS 运行链路；Thread、Message、Composer、Reasoning、Tool Call 与 Thread List 使用官方 Runtime/Primitives/Elements。
- URL 仅负责会话导航，`remoteId === externalId === thread_id`；持久化 `ToolMessage.artifact` 是刷新后工具展示的权威来源。
- 生产前端固定使用同源 `/api`，不读取或写入用户自定义 endpoint；Compose 支持固定单 worker 的单机自托管，非高可用集群。

## 持续决策

- 历史记录（已由 2026-11-09 OSS 迁移取代）：2026-09-21 用户要求修正本地重载的许可证限制；Compose 不再强制 `LANGGRAPH_CLOUD_LICENSE_KEY`。Docker 本地运行仍需具备 LangSmith Deployment 访问权限的 `LANGSMITH_API_KEY`；保留现有 PostgreSQL 存储，不自动切换 `langgraph dev`。操作说明见 `docs/deployment.md`。

- Agent 自主选择工具与证据组织，不在提示词固化流程；平台事实、视觉复核、天气关联和风险措辞遵循 `AGENTS.md` 的证据边界。
- 用户输入、历史、外部资料、工具结果与模型输出均视为不可信数据；工具保持只读、最小权限，内部诊断不进入消息或 artifact。
- 仅重试可判定的瞬时失败；参数、权限、业务拒绝、空数据和格式错误不重试。Provider、Vendor 与 Protocol 保持解耦。
- 不维护第二套前端状态机、传输协议、工具生命周期、消息存储、Thread 存储、重试引擎或 ReAct loop。
- 新增基础设施前依次复核 LangChain/LangGraph、assistant-ui、shadcn/Radix 与官方 registry；workaround 必须有回归测试和删除条件。
- 2026-11-09 用户授权免费 OSS 自托管与腾讯云自动部署；云端新会话、本机旧数据库保留。重新生成仅显示最新回答，旧 checkpoint 留存；无需 Agent Server 许可证。当前部署操作与边界见 docs/deployment.md。

## 临时例外

- `DeepSeekThinkingChatModel` 仅补足 DeepSeek 多轮 tool-loop 的 `reasoning_content` 回传；官方 integration 原生支持并通过回归测试后删除。
- 场地环境的 DEM 或地质外部数据源故障局部隔离，已取得证据继续展示，缺失写入 `limitations`。

## 验证入口

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py" -v

cd ..\frontend
pnpm run test:gate

cd ..
git diff --check
```

真实模型与真实监测平台不进入 PR 门禁；API 与浏览器测试需要隔离 lma_test 数据库，通过 LMA_TEST_DATABASE_URI 指定。不得提交 `.env`、密钥、令牌、真实账号、隐私数据或测试生成物。


## 2026-09-21 用户消息操作与基准站适用性答复

- 用户明确重新授权本次工具与聊天交互代码修复，不涉及配置或部署改造。
- GNSS 数值查询和视觉分析对基准站直接返回模型说明及 `artifact=None`，不请求序列数据、不产生图表或错误卡片。正常空数据仍返回标准展示结构，其他业务错误保持可见。
- 前端仅在工具正常完成且 artifact 明确为 null 时省略卡片，不解析 content；尚未收到 artifact（undefined）与真实错误保持原有显示逻辑。
- 编辑视图由官方 `ThreadPrimitive.Messages` 的 `EditComposer` 配置选择，提交与复制使用官方 Primitives；只允许最新用户消息编辑，生成期间隐藏操作。
- 用户与 AI 工具栏悬停显示，AI 底部固定保留高度，避免出现按钮时消息移动。
- 隔离服务已验证消息编辑、重新生成及刷新恢复；尚未使用真实账号或模型复现用户所报的编辑失败，不能据此宣称所有历史会话问题均已消除。
- 验证：后端 unittest 共 78 项（2 项按配置跳过）、前端 Vitest 60 项、Playwright 10 项通过，生产构建与 `git diff --check` 通过；浏览器覆盖已有会话首轮编辑、多轮编辑、刷新恢复、复制、历史编辑限制、悬停位置稳定及两种基准站工具的刷新展示。
- 用户消息工具栏位于气泡右下方，复制与编辑横向排列；气泡容器固定预留底部空间，悬停显隐不改变消息高度。

## 2026-11-09 腾讯云 OSS 自托管与自动部署验收

- 腾讯云 IP HTTPS 入口已启用，证书链校验、未鉴权 401、鉴权后的首页与静态资源 200 均通过。IP 短期证书每 6 小时检查续期，Certbot 模拟续期成功。
- GitHub Actions 已完成测试与自动发布，首次成功发布提交为 `5fa0519a9db604499a80d5957b4ca66ddb140c3e`；后端 85 项、前端 51 项、浏览器生命周期 10 项及生产构建通过。发布记录：https://github.com/C-jcbest/LMA/actions/runs/42511318893 。
- 真实云端 Run 已完成，当前时间工具和监测平台分组查询均返回 success；本次没有执行完整滑坡分析、视觉服务或全部外部数据源验收。
- 云端使用独立 PostgreSQL 卷，原本机容器和会话保持不动；部署密钥、生产配置和访问口令已安全配置，不存入 Git。
- 当前为单机单 worker，更新可能中断正在运行的请求；备份仅保存在服务器，仍需运维检查磁盘并安排异地备份。配置与恢复步骤见 [deployment.md](deployment.md)。

## 2026-11-09 取消跨会话并发数量限制

- 用户要求遵循不设置并发上限的默认行为；移除自托管 API 自行添加的最多两个活动 Run 限制，同时删除 SERVER_MAX_RUNS 配置，不再因两个其他会话正在运行而返回 429。Uvicorn 的 limit_concurrency 官方默认值为 None，部署不覆盖该参数。
- 同一会话仍只允许一个 Run，重复提交返回 409，避免 checkpoint 历史冲突。数据库连接池、容器内存、供应商配额和单轮调用预算分别保留，不把取消并发数量限制解释为资源无限。
- 新增隔离 PostgreSQL 回归：三个会话的工具阶段实际重叠运行并分别成功持久化，同时验证重复提交拒绝和普通健康请求仍可处理；本地 API 八项测试通过。负载过高可能导致响应变慢、供应商限流、数据库等待超时或内存耗尽中断，不声称服务器具有无限吞吐能力。
