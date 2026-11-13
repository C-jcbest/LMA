# 0001：采用 LangChain create_agent 与官方 Checkpoint

- 日期：2026-09-15
- 状态：有效

> 决策记录保存当时的背景与理由，是历史，不是现行规则的来源。现行架构见 [architecture.md](../architecture.md)；被取代的内容以后续记录为准。

## 背景与决定

主 Agent 是工具驱动的 ReAct 循环，采用 LangChain 官方 `create_agent`。LMA 维护监测领域逻辑与必要适配，由 FastAPI 管理会话目录与 Run，官方 AsyncPostgresSaver 管理 Checkpoint，不再维护手写通用循环或第二套会话历史。

运行工厂为 [graph.py](../../backend/app/agent/graph.py) 中的 `create_lma_agent`；API lifespan 注入 PostgreSQL checkpointer，迁移由一次性任务执行。具体依赖版本以 [requirements.txt](../../backend/requirements.txt) 和前端 lockfile 为准。
