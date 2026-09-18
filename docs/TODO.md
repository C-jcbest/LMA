# LMA 待办入口

当前实施与验收清单见 [TODO_2026-09-15.md](TODO_2026-09-15.md)。旧版 2026-09-14 清单已完成，其补丁方案和旧编号不再适用于官方能力重构，故移除，避免与现行清单冲突。

- 第一阶段 TODO 1–3 已完成，保留测试回归。
- TODO 4–15 已完成；TODO 16 的模型 Provider 显式化实现与自动化门禁已完成（官方 `init_chat_model` 单一工厂 + 两套 endpoint 配置 + 五个独立 thinking 开关）。尚待使用真实 DeepSeek 服务完成 `model → tool → model → final` thinking tool loop 验收后正式封存；完成前不提前进入 TODO 17。架构与部署边界见 [ADR 0001](adr/0001-agent-runtime.md)。
- 当前实现与持续有效决策见 [project-status.md](project-status.md)。
