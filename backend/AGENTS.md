# 后端约定

通用规则见根目录 [AGENTS.md](../AGENTS.md)，架构见 [当前架构](../docs/architecture.md)，环境与完整测试说明见 [开发指南](../docs/development.md)。

- 使用 `backend/.venv` 的 Python 3.13；测试在 backend 目录运行 `.venv/Scripts/python.exe -m unittest discover -s tests -p "test*.py"`。
- API 与持久化测试必须设置 LMA_TEST_DATABASE_URI，且数据库名为 lma_test；未设置时这些测试会跳过，不等于通过。禁止连接业务数据库。
- 改提示词前读 [app/agent/prompts/AGENTS.md](app/agent/prompts/AGENTS.md)。
- 工具的 content 只放模型判断需要的事实，artifact 只放可发往前端的展示数据；两者都不放秘密、请求 URL 或原始异常。
- 新增或修改配置时，同步 [config.py](app/config.py) 与 [.env.example](.env.example) 的中文说明。
- 真实模型评测（evaluations/）会消耗额度，需显式设置 LMA_RUN_MODEL_EVAL=1，只在用户要求或修改提示词时运行。
