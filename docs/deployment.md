# 自托管与自动部署

## 当前运行方式

后端为 FastAPI + LangChain/LangGraph OSS，使用官方 AsyncPostgresSaver 保存会话 checkpoint。前端为 React + assistant-ui，经官方 useLangGraphRuntime 接入 SSE。无需 LangSmith Deployment、Agent Server 或生产许可证；腾讯云资源和模型 API 的费用仍由对应服务计费。

本部署面向单台小型服务器，固定 **一个 Uvicorn worker**，采用异步方式处理并发请求；API 不设置跨会话 Run 数量上限，Uvicorn 不配置 limit_concurrency（官方默认 None）。同一会话只允许一个 Run，重复提交返回 409，避免历史冲突。运行不具备分布式队列或跨进程接管能力；服务重启后，未结束 Run 显式标为 interrupted，不自动重放请求。重新生成与编辑使用官方 checkpoint fork，界面展示最新回答；用户已选择暂不提供旧回答分支切换。

不设置 Run 数量上限不代表资源无限。并发增加时，数据库连接池仍会等待可用连接，模型和监测服务仍受供应商配额约束；可能出现响应变慢、外部 429 或等待超时。后端容器内存上限为 768 MiB，内存耗尽可能导致进程被终止并重启，正在运行的流会中断。单轮模型/工具调用预算和上下文窗口是另一层限制，见 [当前架构](architecture.md#上下文与预算)。

云端使用独立 lma-cloud Compose 项目和 lma-cloud_oss_pgdata 卷；本地 Compose 项目名为 lma-oss。本机旧 lma 项目和 lma_pgdata 卷保留，不迁移、不清除；不兼容旧 Agent Server 数据格式。

## 腾讯云入口与文件

- 入口示例：https://lma.example.invalid ，HTTPS + 应用登录页；实际地址和账号密码由部署管理员提供，不进 Git。
- 访问保护：/opt/lma/shared/.env 中配置 AUTH_USERNAME（默认 admin）、AUTH_PASSWORD 和至少 32 个字符的 AUTH_SECRET。登录后发放 7 天有效、带签名的 HttpOnly Cookie；修改密码或密钥后所有浏览器需要重新登录。除 /api/health 与 /api/auth/* 外的接口未登录返回 401，部署流水线据此检查 /api/sessions。网关不再使用 Basic Auth。
- 主机网关：/etc/nginx/sites-available/lma，模板见 ops/nginx.conf（启用 http2）。模板不随部署自动更新，修改后需在主机上同步并 `nginx -t && systemctl reload nginx`。
- 前端容器的 nginx 负责静态资源 gzip（不含 SSE）与缓存：`/assets/` 带内容哈希、长期缓存，`index.html` 每次协商。
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

## Langfuse Cloud 调查追踪

主调查可通过 Langfuse Cloud 查看每轮模型与工具调用、耗时、token 用量和错误。LMA 主机不增加 Langfuse、ClickHouse 等服务；配置说明以 [Settings](../backend/app/config.py) 和 [.env.example](../backend/.env.example) 为准。

1. 在 Langfuse Cloud 创建自己的组织和 LMA 项目，选择数据区域；在项目设置的 API Keys 创建一组项目公钥与私钥。区域地址必须与密钥所属项目一致，不自动切换区域。
2. 在生产 `/opt/lma/shared/.env` 配置 `LANGFUSE_ENABLED=true`、项目的 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`，并将 `LANGFUSE_TRACING_ENVIRONMENT` 设为 `production`。本地开发使用自己的 `backend/.env`；密钥不提交版本库，也不写进聊天。
3. 正常部署并重建 API 容器以载入环境；只修改文件不会更新已启动的进程。未启用追踪时无需 Cloud 账号，业务服务不依赖追踪平台的在线状态。
4. 完成一轮真实调查，在 Cloud 的 Traces 查看 `lma-investigation`，确认会话归组、`lma_run_id`、`lma_run_status`、模型用量与工具子调用；受控工具失败可以与整轮成功同时出现。费用依赖 Cloud 中的模型定价，自定义或新模型需核对价格配置。

追踪会上传调查问题、模型输入输出和工具数据（包括调用中携带的历史）；凭据脱敏范围和未覆盖的独立调用见 [调查可观测性](architecture.md#调查可观测性)。关闭开关并重建 API 容器会停止新追踪，不自动删除已上传的记录；数据保留和删除在 Langfuse 项目中管理。

排查未出现的记录时先核对区域、API Keys、开关、Cloud 配额和容器到区域域名的 HTTPS 连通性，再看 SDK 导出日志；后台批量发送不会立即出现在面板中。不要通过同步等待每轮 flush 来改变 SSE 延迟。官方接入见 [LangChain 集成](https://langfuse.com/integrations/frameworks/langchain)。

## 生产外部数据服务 DNS

腾讯云主机使用 systemd-resolved。Open-Meteo 域名按路由交给 Cloudflare 的两个递归 DNS（1.1.1.1、1.0.0.1）；eth0 的 `~.` 路由让其他域名继续走原腾讯云 DNS。配置只指定解析器，不保存天气服务 IP，不修改 HTTPS 域名、SNI 或证书校验。Docker 当前通过宿主机 stub 转发外部解析，容器内仍保留 Docker 服务名解析。

- [解析路由配置](../ops/dns/open-meteo-resolved.conf) 安装到 `/etc/systemd/resolved.conf.d/60-lma-open-meteo.conf`。
- [默认路由配置](../ops/dns/default-route.network.conf) 安装到 `/etc/systemd/network/10-netplan-eth0.network.d/60-lma-default-dns-route.conf`。该路径对应当前 `networkctl status eth0` 显示的 Network File；更换网卡或基础网络文件时需同步核对。
- 两份配置必须配套：仅增加全局 DNS 而不指定 eth0 的 `~.`，可能影响其他域名。自动发布不覆盖主机配置。
- 生效使用 `systemctl restart systemd-resolved`、`networkctl reload`、`resolvectl domain eth0 '~.'` 和 `resolvectl flush-caches`；持久文件供服务重启及主机重启时加载。无需重启 Docker 或修改网卡地址、网关。
- 检查 `resolvectl status` 的全局 `~open-meteo.com` 与 eth0 的 `~.`，并从 API 容器调用天气、地形和地质查询。只验证宿主机 curl 不足以证明运行容器恢复。
- 回退时只移除上述两份本次添加的配置文件，重启 resolved、执行 `networkctl reload` 与 `resolvectl domain eth0 ''` 并清缓存，恢复原腾讯云 DNS；不得覆盖其他主机配置。

该配置解决已复现的解析节点 TLS 可达性差异，不保证外部服务永久可用。若再次超时，先核对动态解析、TCP 与 TLS 阶段，再检查供应商状态，不固定某次成功的服务 IP。

## GitHub Actions

.github/workflows/ci-deploy.yml 在面向 main 的 PR、推送 main 和手动触发时运行测试与部署；只改 docs/、README.md 或 AGENTS.md 时不触发，提示词 Markdown 不在排除范围内。.github/workflows/docs-check.yml 对所有面向 main 的推送和 PR 运行文档检查，不部署。

1. PostgreSQL 隔离数据库上运行后端 unittest。
2. 前端 Vitest、Chromium 关键交互回归与 Vite 生产构建。浏览器只安装 headless shell，测试文件最多并行两个，文件内串行。
3. 仅 main 且测试成功时，在 production environment 自动部署相同 commit。PR 不读取部署密钥、不发布。

同一分支的新提交取消仍在运行的旧测试；部署使用独立串行锁，已开始的部署不会因新测试被取消。CI 只在 Linux 上运行。

production environment 中配置：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| LMA_DEPLOY_KEY | Secret | 专用受限 SSH 私钥，无默认值 |
| LMA_HOST | Variable | 腾讯云公网 IP，无默认值 |
| LMA_SSH_USER | Variable | lma-deploy，仅用于部署 |
| LMA_SSH_KNOWN_HOSTS | Variable | 管理连接核验过的服务器 SSH host key，禁止关闭严格校验 |

CI 和人工发布统一使用 `ops/package-release.py` 打包指定提交，不上传 .env 或工作区未提交文件。`.gitattributes` 的 `export-ignore` 排除测试、文档和 CI 配置，发布包只保留运行和构建需要的文件；前端 `.dockerignore` 同时排除测试及其配置，单改测试不会使生产构建层失效。脚本固定禁用 Git 换行转换并输出 tar.gz；构建输入和发布脚本另由 .gitattributes 固定 LF，避免 Windows 与 Linux 的依赖文件内容不同而误失效缓存。服务器 forced-command 密钥只允许部署入口，参数必须为 40 位十六进制 SHA，不开放交互 shell、端口转发或 root SSH 密钥。发布串行执行，允许相同归档重跑；同 SHA 内容不同或解压不完整会拒绝。

用户明确要求本次跳过测试时，可在提交中使用 `[skip ci]` 跳过自动流水线，再通过管理员连接调用同一服务器部署程序；构建、数据库备份、迁移和上线健康检查仍保留。在 Windows 仓库根目录使用 `backend/.venv/Scripts/python.exe ops/package-release.py --output <归档文件>`，Linux 使用 `python3 ops/package-release.py --output <归档文件>`，均默认打包 HEAD；`--revision` 可指定提交。将归档上传为独立临时文件，再执行 `/usr/local/sbin/lma-deploy <脚本输出的完整提交 SHA> < <临时归档路径>`；临时文件不能使用部署程序写入的 `/opt/lma/incoming/<SHA>.tar.gz`，否则重定向读取时会被截断。

后端 pip 和前端 pnpm 使用 BuildKit 缓存挂载保存已下载的包；依赖清单变化后也可复用下载，依赖清单未变化时仍优先命中整个安装层。缓存只留在构建器中，不进入运行镜像；不要在每次发布前清空构建缓存。

后端包源由 Compose 构建参数 `LMA_PIP_INDEX_URL` 控制，默认 `https://pypi.org/simple`。腾讯云生产服务器在 `/opt/lma/shared/.env` 配置 `LMA_PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple/`，仅在构建安装时使用该包源；不自动切换其他来源。当前固定版本的直接依赖已核验可从腾讯镜像取得，间接依赖和平台适配以实际构建结果为准。迁移服务和 API 服务共用同一后端构建配置。

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
