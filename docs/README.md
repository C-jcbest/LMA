# 文档目录

AGENTS.md 保留通用协作规则；本目录提供按任务查阅的项目知识。修改前阅读相关条目，核对代码和测试，不把产品目标或历史验收当成当前运行结果。

| 当前任务 | 先读 | 内容归属 |
| --- | --- | --- |
| 首次开发、定位代码、执行测试 | [开发指南](development.md) | 本地环境、代码入口、验证范围 |
| 修改 Agent、会话、工具协议或前端 Runtime | [ADR 0001](adr/0001-agent-runtime.md) | 当前架构、责任边界和实现约束 |
| 修改监测判断、气象或场地分析 | [产品需求](../prd.md) | 业务语义、证据边界和产品优先级 |
| 调整部署、数据库或 CI/CD | [部署说明](deployment.md) | 环境隔离、部署和恢复操作 |
| 对接北斗平台 | [接口参考](reference/beidou-platform-api.md) | 上游请求和字段约定 |
| 接续未完成工作、判断验收范围 | [待办](TODO.md)、[项目状态](project-status.md) | 未完成事项、已验证事实和限制 |

## 维护方式

- 同一规则只在所属文档维护，其他位置用链接引用。README 只负责项目介绍和入口；AGENTS 不加入发布记录、任务清单或接口细节。
- 配置默认值、范围与生效边界共同维护在 [Settings](../backend/app/config.py) 和 [.env.example](../backend/.env.example)，新增或修改配置时逐项补充中文说明，不在多个文档复制配置表。
- 提示词只在 [prompts](../backend/app/agent/prompts/) 维护；代码路径和依赖版本以源码、配置及锁文件为准，不生成另一套符号索引。
- 待办完成后移除实施步骤，在项目状态保留必要的验收结论与未验证范围。过时决策和已提交的长篇过程记录通过 Git 历史追溯。
- 当前规模采用一个开发指南、一个架构决策和现有领域文档；仅当出现独立维护的子系统时再拆分，不预建多层 agent 指令或知识库。

## 组织方式参考

本次整理参考以下公开资料的检索摘要，采用按任务查阅和单一内容归属；没有照搬其行数阈值或额外工具链：

- [HumanLayer：Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)：常驻指令聚焦通用事项，任务细节按需读取。
- [agent-engineering-toolkit：Progressive disclosure guide](https://github.com/rodrigorjsf/agent-engineering-toolkit/blob/8ab7364e782d65e2253acfe9e5eb5c53780aaee3/skills/init-agents/references/progressive-disclosure-guide.md)：按文档职责组织项目知识。
- [libretto：Updating AGENTS.md documentation](https://github.com/saffron-health/libretto/blob/41ab782ccea765d7a9a3c9b56b1b2586723962e3/.agents/skills/update-docs/references/updating-agents-docs.md)：给出清晰的阅读触发条件，将大型主题移入专门文档。
