# LMA · 滑坡连续监测智能体

LMA 使用监测平台的 GNSS、站点与分组数据，结合曲线视觉复核、天气和场地环境资料，帮助监测人员调查变化并整理证据。视觉候选需要数值复核，气象关联不代表因果；系统不发布官方预警或撤离命令。

后端采用 Python、FastAPI、LangChain / LangGraph OSS 和 PostgreSQL；前端采用 React、TypeScript、Vite 和 assistant-ui。会话历史以服务端 Thread / Checkpoint 为准。

## 开始使用

- [开发指南](docs/development.md)：依赖安装、本地启动、代码入口和测试命令。
- [部署说明](docs/deployment.md)：Compose、腾讯云 HTTPS、访问保护、CI/CD 和恢复操作。
- [产品需求](prd.md)：业务目标、分析口径和证据边界。

## 参与开发

先阅读 [AGENTS.md](AGENTS.md) 的协作规则，再按[文档目录](docs/README.md)查阅本次任务涉及的项目约束。[项目状态](docs/project-status.md)记录验收证据和限制，[待办](docs/TODO.md)列出尚未完成的工作。
