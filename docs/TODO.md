# LMA 待办入口

当前实施与验收清单见 [TODO_2026-09-15.md](TODO_2026-09-15.md)。旧版 2026-09-14 清单已完成，其补丁方案和旧编号不再适用于官方能力重构，故移除，避免与现行清单冲突。

- 第一阶段 TODO 1–3 已完成，保留测试回归。
- TODO 4 已完成：生产入口使用官方 create_agent + middleware，并通过隔离 Agent Server E2E；TODO 5 官方摘要迁移也已完成，TODO 6 工具协议与用户可见边界已完成，TODO 7 官方重试与单轮调用预算已完成，下一项为 TODO 8 会话生命周期。架构与部署边界见 [ADR 0001](adr/0001-agent-runtime.md)。
- 当前实现与持续有效决策见 [project-status.md](project-status.md)。
