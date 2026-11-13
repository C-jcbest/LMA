# 文档目录

根目录 [AGENTS.md](../AGENTS.md) 是每次都要遵守的协作规则；本目录按任务提供项目知识，只在需要时读。修改前核对代码和测试，不把路线图或历史记录当成当前运行结果。

## 按任务查阅

| 当前任务 | 先读 | 内容归属 |
| --- | --- | --- |
| 首次开发、定位代码、执行测试 | [开发指南](development.md) | 本地环境、代码入口、验证范围 |
| 修改 Agent、会话、工具协议、地图或前端 Runtime | [当前架构](architecture.md) | 现行架构与必须保持的边界 |
| 修改监测判断、气象或场地分析 | [产品规则](product/rules.md) | 业务语义与证据边界 |
| 修改运行时提示词 | [提示词修改规则](../backend/app/agent/prompts/AGENTS.md) | 规则放置、评测与长度上限 |
| 调整部署、数据库或 CI/CD | [部署说明](deployment.md) | 环境隔离、部署和恢复 |
| 对接北斗平台 | [接口参考](reference/beidou-platform-api.md) | 上游请求和字段 |
| 接续工作、判断验收范围 | [状态与待办](status.md) | 当前状态、未验证项、待办 |
| 了解某个设计为什么这样做 | [决策记录](decisions/) | 当时的背景与理由（历史） |

## 现状文档与历史记录

- **现状文档**（architecture、product/rules、status、development、deployment）只写当前是什么样。设计改变时直接改写对应段落，不在末尾追加“某日更新”。
- **决策记录**（decisions/NNNN-标题.md）一项决定一份，写背景、决定、理由和状态；被取代时只改状态并指向新记录，原文不改。它是历史，不能作为现行规则的依据。
- **验收报告与过程记录**写进 PR 或提交说明。确需长期保留的放 [reviews](reviews/)，同样是历史。
- [产品定位与路线图](product/roadmap.md)是方向，不是实施任务。

## 维护规则

- 同一规则只在所属文档维护，其他位置用链接引用。README 只负责介绍和入口；AGENTS 不写发布记录、任务清单或接口细节。
- 配置默认值、范围与生效边界只在 [Settings](../backend/app/config.py) 和 [.env.example](../backend/.env.example) 维护，新增配置时逐项写中文说明。
- 提示词只在 [prompts](../backend/app/agent/prompts/) 维护；代码路径和依赖版本以源码、配置及锁文件为准。
- 不写会很快过期的数字（测试数量、行数、耗时），改为给出验证命令。
- 删除功能、改名或换掉服务时，在 [ops/retired-terms.txt](../ops/retired-terms.txt) 追加旧名称；`python ops/check_docs.py` 会检查链接、旧名称回流和常驻文件长度，CI 对每次推送运行。
- 指令文件分层：根 AGENTS.md 放通用规则；backend、frontend 和提示词目录的 AGENTS.md 只放该目录的约定，并在长度上限内。

## 组织方式参考

参考以下公开做法，按本项目规模取舍，没有照搬其工具链：

- [AGENTS.md](https://agents.md/) 约定：根目录放通用规则，子目录放就近规则。
- [HumanLayer：Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)：常驻指令聚焦通用事项，任务细节按需读取。
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：常驻上下文尽量少，细节按需读取。
- Michael Nygard 的 [ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) 格式：一项决定一份记录，被取代时标注状态。
- [Diátaxis](https://diataxis.fr/)：按用途区分操作指南、参考与原理说明。
