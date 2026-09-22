# 部署边界与操作

## 支持范围

仓库根目录的 `docker-compose.yml` 用于本地持久化开发、论文演示和小规模自托管验证。它提供单实例 Nginx、LangGraph Agent Server、PostgreSQL 与 Redis，不提供高可用、弹性伸缩、滚动发布、备份编排或多租户隔离，因此不得作为完整的生产集群标准。

真正的生产级集群应采用官方 LangSmith / LangGraph Helm 路线并部署到 Kubernetes。仓库不维护第二套自制 Kubernetes manifests。

## Compose 启动

1. 在 `backend/.env` 配置模型、北斗平台与视觉服务，并设置以下 standalone 基础设施变量：

   - `LANGSMITH_API_KEY`：Docker 本地运行必填，须具备 LangSmith Deployment 访问权限。
   - `LANGGRAPH_CLOUD_LICENSE_KEY`：生产部署许可证，本地运行不要求；可留空，配置后由 `env_file` 注入。
   - `POSTGRES_PASSWORD`：Compose PostgreSQL 密码，必填。

2. 构建 Agent Server 镜像并启动整套服务：

```powershell
cd backend
langgraph build -t lma-agent:latest
cd ..
docker compose --env-file backend/.env up -d --build
docker compose --env-file backend/.env ps
```

3. 访问 `http://127.0.0.1:8080`。浏览器只连接同源 `/langgraph-api`，Nginx 再转发到 Agent Server；生产构建不会读取或写入浏览器中遗留的自定义 endpoint。

项目根目录的 `.\reload-backend.ps1` 使用这套 Compose 配置重建后端。本地运行不应因缺少生产许可证被 Compose 拦截，但仍需满足上述 LangSmith 密钥权限；不具备该权限时使用下文 `langgraph dev` 本地开发方式，其存储与 Compose PostgreSQL 独立，不会自动载入原有容器会话。

PostgreSQL 数据保存在 `lma_pgdata` named volume。`docker compose down` 不删除会话；`docker compose down -v` 会永久删除该卷，执行前必须确认不再需要其中数据。

Compose 为 PostgreSQL、Redis、Agent Server 和前端配置了 healthcheck。`frontend` 仅在 Agent Server 健康后启动；健康检查不替代外部监控、备份与告警。

## Vite 前端交付

前端保持 React + Vite。`pnpm build` 生成纯静态 `frontend/dist/`，可由仓库提供的 Nginx 镜像、Caddy 或现有网关托管。外部网关必须保持以下同源路由：

```text
/                 -> frontend/dist
/langgraph-api/*  -> LangGraph Agent Server（转发时移除 /langgraph-api 前缀）
```

开发环境仍可在“服务配置”中修改测试 endpoint；生产构建固定使用 `/langgraph-api`，普通用户不能覆盖。

## 本地开发

本地开发不需要 standalone license：

```powershell
cd backend
.\.venv\Scripts\langgraph.exe dev --config .\langgraph.json --port 2024 --no-browser

cd ..\frontend
pnpm dev
```

Vite 将 `/langgraph-api` 代理到 `LMA_LANGGRAPH_PROXY_TARGET`；未设置时目标为 `http://127.0.0.1:2024`。
