# 项目状态与有效决策

更新：2026-09-21。本文件只记录当前事实、持续决策和临时例外。实施计划与验收状态见 [TODO.md](TODO.md)，部署操作见 [deployment.md](deployment.md)，产品与协作约束分别以 `prd.md`、`AGENTS.md` 为准。

## 当前事实

- 后端主图使用 LangChain `create_agent`，由 LangGraph Agent Server 管理 Thread、Run 和 Checkpoint；历史摘要、重试、调用限额与工具错误采用官方 Middleware。
- 工具使用 Pydantic 参数和 `content_and_artifact`；前端只展示严格判别的 `artifact.data`，不解析工具 content 或原始 JSON。
- 上下文实际用量只来自供应商 `usage_metadata`，窗口上限只来自模型 `profile.max_input_tokens`；摘要阈值独立配置。
- `system.md`、`vision.md` 是对应策略的唯一编辑源；业务时间统一通过 `get_current_time` 获取，时区为 `Asia/Shanghai`。
- 会话标题由 assistant-ui Adapter 调用独立 `session-title` 图生成并持久化；下一步建议保留在主 Run，日志记录正文完成、terminal ready 和推荐阶段耗时。
- 前端只有一条 assistant-ui -> React LangChain -> LangGraph Server 运行链路；Thread、Message、Composer、Reasoning、Tool Call 与 Thread List 使用官方 Runtime/Primitives/Elements。
- URL 仅负责会话导航，`remoteId === externalId === thread_id`；持久化 `ToolMessage.artifact` 是刷新后工具展示的权威来源。
- 生产前端固定使用同源 `/langgraph-api`，不读取或写入用户自定义 endpoint；Compose 只支持开发、演示和小规模自托管验证。

## 持续决策

- Agent 自主选择工具与证据组织，不在提示词固化流程；平台事实、视觉复核、天气关联和风险措辞遵循 `AGENTS.md` 的证据边界。
- 用户输入、历史、外部资料、工具结果与模型输出均视为不可信数据；工具保持只读、最小权限，内部诊断不进入消息或 artifact。
- 仅重试可判定的瞬时失败；参数、权限、业务拒绝、空数据和格式错误不重试。Provider、Vendor 与 Protocol 保持解耦。
- 不维护第二套前端状态机、传输协议、工具生命周期、消息存储、Thread 存储、重试引擎或 ReAct loop。
- 新增基础设施前依次复核 LangChain/LangGraph、assistant-ui、shadcn/Radix 与官方 registry；workaround 必须有回归测试和删除条件。
- 生产级集群采用官方 LangSmith/LangGraph Helm + Kubernetes 路线，仓库不维护自制 Kubernetes manifests。

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

真实模型与真实监测平台不进入 PR 门禁；隔离 Server E2E 由 `LMA_RUN_SERVER_E2E=1` 显式启用。不得提交 `.env`、密钥、令牌、真实账号、隐私数据或测试生成物。
