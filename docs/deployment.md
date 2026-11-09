# 自托管与自动部署

## 当前运行方式

后端为 FastAPI + LangChain/LangGraph OSS，使用官方 AsyncPostgresSaver 保存会话 checkpoint。前端为 React + assistant-ui，经官方 useLangGraphRuntime 接入 SSE。无需 LangSmith Deployment、Agent Server 或生产许可证；腾讯云资源和模型 API 的费用仍由对应服务计费。

本部署面向单台小型服务器，固定 **一个 Uvicorn worker**，采用异步方式处理并发请求；API 不设置跨会话 Run 数量上限，Uvicorn 不配置 limit_concurrency（官方默认 None）。同一会话只允许一个 Run，重复提交返回 409，避免历史冲突。运行不具备分布式队列或跨进程接管能力；服务重启后，未结束 Run 显式标为 interrupted，不自动重放请求。重新生成与编辑使用官方 checkpoint fork，界面展示最新回答；用户已选择暂不提供旧回答分支切换。

不设置 Run 数量上限不代表资源无限。并发增加时，数据库连接池仍会等待可用连接，模型和监测服务仍受供应商配额约束；可能出现响应变慢、外部 429 或等待超时。后端容器内存上限仍为 768 MiB，内存耗尽可能导致进程被终止并重启，正在运行的流会中断。此变更不调整单轮模型/工具调用预算或上下文窗口；这些限制属于不同层次。

云端使用独立 lma-cloud Compose 项目和 lma-cloud_oss_pgdata 卷，从新会话开始。本机原 lma 项目、lma_pgdata 和已有会话不迁移、不清除；新本地 Compose 名称为 lma-oss。本次不提供旧 Agent Server 数据格式兼容。

## 腾讯云入口与文件

- 入口：https://82.157.57.59 ，HTTPS + Nginx Basic Auth；访问口令不进 Git。
- 主机网关：/etc/nginx/sites-available/lma，模板见 ops/nginx.conf。
- 生产配置：/opt/lma/shared/.env，权限 600，仅由服务器读取；修改后重新部署。
- 代码版本：/opt/lma/releases/＜commit SHA＞；/opt/lma/current 指向最近成功版本。
- 部署程序：root 所有的 /usr/local/sbin/lma-deploy，源码见 ops/deploy.sh。CI 的代码归档不自动覆盖此特权程序，修改后由管理员审阅并安装。
- PostgreSQL、API、前端容器只映射到 127.0.0.1:55433、:2025、:8081，公网仅经网关访问。云安全组允许 TCP 80、443 和部署所需 SSH 端口，数据库端口无需开放。

IP 证书使用 Let’s Encrypt shortlived profile，证书有效期约 6 天，Certbot 安装在 /opt/lma-certbot。lma-certbot.timer 每 6 小时检查续期，成功后 reload Nginx。80 端口的 /.well-known/acme-challenge/ 必须保持公网可达。检查命令：

~~~bash
systemctl list-timers lma-certbot.timer
journalctl -u lma-certbot.service --since '2 days ago'
/opt/lma-certbot/bin/certbot certificates
~~~

## GitHub Actions

仓库 C-jcbest/LMA 的 .github/workflows/ci-deploy.yml 在 PR、推送 main 和手动触发时运行：

1. PostgreSQL 隔离数据库上运行后端 unittest。
2. 前端 Vitest、Chromium 会话生命周期回归与 Vite 生产构建。
3. 仅 main 且测试成功时，在 production environment 自动部署相同 commit。PR 不读取部署密钥、不发布。

production environment 中配置：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| LMA_DEPLOY_KEY | Secret | 专用受限 SSH 私钥，无默认值 |
| LMA_HOST | Variable | 腾讯云公网 IP，无默认值 |
| LMA_SSH_USER | Variable | lma-deploy，仅用于部署 |
| LMA_SSH_KNOWN_HOSTS | Variable | 管理连接核验过的服务器 SSH host key，禁止关闭严格校验 |

CI 经 git archive 发送已测试的提交，不上传 .env 或工作区未提交文件。服务器 forced-command 密钥只允许部署入口，参数必须为 40 位十六进制 SHA，不开放交互 shell、端口转发或 root SSH 密钥。发布串行执行，允许相同归档重跑；同 SHA 内容不同或解压不完整会拒绝。

部署先构建镜像；已有版本在构建期间继续运行。更新容器前对现有云端数据库执行 pg_dump，随后由一次性 migrate 服务运行官方 checkpointer setup，再等待服务健康。仅在 API 与首页检查成功后更新 current。容器切换时可能短暂中断，正在运行的请求可能停止；本方案不承诺零停机。测试成功不代表外部监测平台和模型始终可用。

失败时查看 Actions 日志和服务器 Compose 日志。构建失败不替换旧容器；替换容器后的失败不自动回滚数据库。备份在 /opt/lma/shared/backups/，代码与镜像保留供人工恢复，需要运维定期检查磁盘并将备份复制到独立存储。当前没有自动清理、异地备份、高可用或多租户隔离。

人工恢复代码时先核对目标目录、备份及 schema 是否兼容，使用经过核验的历史 SHA：

~~~bash
export LMA_ENV_FILE=/opt/lma/shared/.env
export LMA_RELEASE=<历史提交SHA>
docker compose --project-name lma-cloud --env-file "$LMA_ENV_FILE" \
  --file "/opt/lma/releases/$LMA_RELEASE/docker-compose.yml" up -d --wait
~~~

这不会恢复数据库。不要在未核对备份、目标数据库和数据损失范围时执行恢复；不要运行 down -v。

## 本地容器

依赖安装、开发服务器和测试命令统一见 [开发指南](development.md)。配置 backend/.env 后，在根目录启动完整服务：

~~~powershell
docker compose --env-file backend/.env up -d --build --wait
~~~

访问 http://127.0.0.1:8081 。reload-backend.ps1 只作用于新 lma-oss 项目，不接管旧容器。数据库使用新卷和 55433 端口，不要执行 down -v 或清理原 lma_pgdata。
