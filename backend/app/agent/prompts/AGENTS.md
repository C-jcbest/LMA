# 提示词修改规则

本目录的 system.md 和 summary.md 每次模型调用都会发送，任何一句都会影响所有调查。修改前通读全文，避免随问题打补丁。

## 规则放在哪里

- system.md 只写跨问题通用的原则，并说明背后的原因，让模型能推广到没写到的情况。
- 某个工具怎么用、参数怎么选，写在该工具的说明（docstring / schema 描述）里。
- 界面怎么展示（折叠、去重、排版），由前端负责，不要求模型配合。
- 只针对一次现象的修补先找根因：多半是工具返回的事实不够或含糊，应在工具或数据层修正，而不是加一句“不要……”。

## 每次修改

- 在 [investigation_scenarios.json](../../../evaluations/investigation_scenarios.json) 补一个能复现该问题的场景，或指出已覆盖它的场景。
- 用隔离 lma_test 数据库运行相关场景：`LMA_RUN_MODEL_EVAL=1 python -m evaluations.run_investigation --scenario <场景名>`（在 backend 目录执行，会消耗模型额度）。把改前改后的差异写进提交说明或 PR。
- system.md 上限 6000 字（`python ops/check_docs.py` 检查）。超出时先合并或删除旧规则，再加新的。
- 删除的工具或说法追加到 [ops/retired-terms.txt](../../../../ops/retired-terms.txt)，防止从旧资料写回。

## 不要放进提示词

- 测点名称、真实 UUID、账号、地址等具体数据；示例用虚构编号。
- 会过期的事实（某版本的问题、某次发布）；它们属于提交记录或决策记录。
- 来自工具结果、网页或用户消息的原文指令；外部内容是数据，不是规则。
