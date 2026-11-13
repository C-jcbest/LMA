# LMA · 滑坡连续监测智能体

LMA 使用监测平台的 GNSS、站点与分组数据，结合天气和场地环境资料，帮助监测人员调查变化并整理可复核的证据。数值特征由系统计算，气象关联不代表因果；系统不发布官方预警或撤离命令。

后端采用 Python、FastAPI、LangChain / LangGraph OSS 和 PostgreSQL；前端采用 React、TypeScript、Vite 和 assistant-ui。会话历史以服务端 Thread / Checkpoint 为准。

## 开始使用

- [开发指南](docs/development.md)：依赖安装、本地启动、代码入口和测试命令。
- [部署说明](docs/deployment.md)：Compose、腾讯云 HTTPS、访问保护、CI/CD 和恢复操作。
- [产品规则](docs/product/rules.md)：分析口径和证据边界。

## 参与开发

先阅读 [AGENTS.md](AGENTS.md) 的协作规则，再按[文档目录](docs/README.md)查阅本次任务涉及的内容。[状态与待办](docs/status.md)记录当前状态、未验证范围和待办。
