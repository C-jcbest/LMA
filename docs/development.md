# 开发指南

开始修改前阅读 [协作规则](../AGENTS.md)，涉及运行链路时阅读 [ADR 0001](adr/0001-agent-runtime.md)。回答、注释和文档优先使用简体中文，代码标识符遵循所在语言惯例。

## 本地环境

使用 Python 3.13、[.nvmrc](../frontend/.nvmrc) 指定的 Node 22 和 pnpm 10.30.3。在仓库根目录执行：

~~~powershell
py -3.13 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
pnpm --dir frontend install --frozen-lockfile
~~~

首次使用时将 backend/.env.example 复制为 backend/.env，填写模型、监测平台和 POSTGRES_PASSWORD。已有文件不要覆盖；不提交 .env、密钥、令牌、真实账号、隐私数据或测试生成物。

本地 Compose 使用独立 lma-oss 项目，数据库端口为 55433。保留旧 lma 项目、原数据库和历史会话，不自动迁移或清除。先启动新数据库：

~~~powershell
docker compose --env-file backend/.env up -d postgres
~~~

确认 backend/.env 中 DATABASE_URI 指向该新数据库，再启动后端；首次启动或依赖升级后执行迁移：

~~~powershell
cd backend
.\.venv\Scripts\python.exe -m app.server.storage
.\.venv\Scripts\python.exe -m app.server
~~~

另一个终端启动前端：

~~~powershell
pnpm --dir frontend dev
~~~

前端地址以 Vite 输出为准。开发模式默认将 /api 代理到 127.0.0.1:2025，可通过 LMA_API_PROXY_TARGET 调整；生产固定同源 /api。整套容器启动和重载见 [部署说明](deployment.md#本地容器)。

## 按改动定位代码

| 改动范围 | 入口 |
| --- | --- |
| Agent 编排、middleware、隐藏消息上下文 | [graph.py](../backend/app/agent/graph.py)、[message_context.py](../backend/app/agent/message_context.py) |
| 主业务与视觉策略 | [system.md](../backend/app/agent/prompts/system.md)、[vision.md](../backend/app/agent/prompts/vision.md) |
| 监测、视觉、天气与场地工具 | [tools.py](../backend/app/agent/tools.py)、[vision.py](../backend/app/agent/vision.py)、[weather.py](../backend/app/agent/weather.py)、[site.py](../backend/app/agent/site.py) |
| 平台请求与字段 | [beidou](../backend/app/beidou/)、[接口参考](reference/beidou-platform-api.md) |
| 会话 API、Run 与存储 | [server](../backend/app/server/) |
| 前端布局与 Runtime | [App.tsx](../frontend/src/App.tsx)、[AssistantProvider.tsx](../frontend/src/app/providers/AssistantProvider.tsx) |
| SSE 与会话目录适配 | [api.ts](../frontend/src/services/api.ts)、[session-list-adapter.ts](../frontend/src/lib/session-list-adapter.ts) |
| 工具展示契约 | [artifacts.py](../backend/app/agent/artifacts.py)、[envelope.ts](../frontend/src/types/envelope.ts)、[toolkit.tsx](../frontend/src/features/monitoring/toolkit.tsx) |
| 聊天组件与领域展示 | [assistant-ui](../frontend/src/components/assistant-ui/)、[monitoring](../frontend/src/features/monitoring/) |

升级 assistant-ui Elements 时，以 frontend/components.json 的官方 registry 为基准，检查本地中文文案、领域展示与交互差异。

## 验证

后端测试、前端单元测试与构建：

~~~powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py" -v
cd ..\frontend
pnpm test
pnpm build
cd ..
git diff --check
~~~

API 集成测试和 Playwright 必须使用独立 **lma_test** 数据库，并设置 LMA_TEST_DATABASE_URI。未配置时，后端 API 测试会跳过，浏览器服务无法启动；单元测试通过不代表完整门禁通过。禁止使用业务数据库。CI 自动提供隔离 PostgreSQL。

首次运行或浏览器版本变化时安装 Chromium，然后执行完整前端门禁：

~~~powershell
cd frontend
pnpm test:e2e:install
pnpm test:gate
~~~

test:gate 包含 Vitest、Playwright 和生产构建。浏览器测试需要后端依赖，使用 21420 / 25174 / 19090 独立端口和 HTTP stub，不调用真实模型或监测账号。

| 回归范围 | 现有入口与保留理由 |
| --- | --- |
| Agent 多轮、并行、取消配对、重试与调用限额 | backend/tests/test_agent_runtime.py；验证 LMA 组装后的实际运行行为 |
| 空数据、业务拒绝、错误脱敏与工具证据 | backend/tests/test_tool_protocol.py；不同工具的业务边界分别保留 |
| 时间、模型配置、气象与场地计算 | backend/tests/test_prompt_time.py；验证项目参数与数值规则 |
| 摘要、失败后历史保留与 token 隔离 | backend/tests/test_context_management.py |
| 图像生成、候选范围与模型协议 | backend/tests/test_vision_rendering.py、test_vision_model.py；后者在 HTTP 边界检验实际请求 |
| PostgreSQL checkpoint、消息注入拒绝、编辑与并发 | backend/tests/test_self_hosted_api.py |
| 领域显示、artifact 校验、服务失败与 SSE | frontend/tests/；单元测试覆盖可精确定位的边界 |
| 导航、Stop、刷新、编辑、复制与分页 | frontend/e2e/thread-lifecycle.spec.ts；使用真实前端、API 与隔离数据库 |
| 窄屏、抽屉、失败原因与草稿保留 | frontend/e2e/layout-feedback.spec.ts；浏览器布局和 HTTP 边界回归 |

新增测试优先补现有入口的独立行为缺口。不要为同一行为重复添加组件挂载测试、SDK 对象取值测试或手写计时器来模拟运行时；跨层测试只保留真实的适配、持久化或浏览器风险。不得通过删掉失败断言掩盖问题。真实服务与真机待验收项统一见 [TODO](TODO.md)。
