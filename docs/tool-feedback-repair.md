# 工具参数纠错与真实查询失败分离（2026-11-11）

## 问题与复现

用户报错调查并未整体失败：模型在一次长期数值查询的参数校验失败后，已缩短窗口、取得长期数据并给出完整回答。旧页面仍将前一次内部校验文案作为查询失败常驻展示。

隔离复现确认：锁定版本的 BaseTool 会将参数 ValidationError 转为 error ToolMessage；EvidenceMiddleware 把没有 artifact 的 error 包装为 acquisition_failure 并存证；前端只有在工具和完整参数都相同时才收起早先失败，因而修正参数后的成功无法消除旧错误。

## 实现与边界

- 工具工厂仍使用官方 create_agent、BaseTool 和 middleware。输入 schema 的校验回调抛出明确的 ToolInputError；报告及调查目标的可纠正引用错误也使用该类型。ToolErrorMiddleware 让该类型继续传到 ToolFeedbackMiddleware，保留官方调用配对、error 状态和模型可操作的纠错反馈。上游数据解析失败、平台拒绝与超时仍走真实失败路径。
- 参数纠错只保留在 checkpoint 审计中，不生成取数证据、不产生证据编号，也不能支持正式报告、目标 answered/insufficient/blocked 或会话测点关联。实时 SSE 与历史读取共用服务端投影，客户端只收到明确分类和受控说明，不收到原始校验细节。
- 对用户已经遇到的存量错误，仅在读取时识别旧数值跨度校验分支：工具名、error 状态、失败产物类型、生成的完整文案、原查询窗口超限须同时匹配。不根据宽泛关键词猜测，不写死测点或调用编号，不改写 checkpoint 或不可变证据。此范围由本次现存错误修复授权覆盖；不增加旧简报读取兼容。
- daily 的资源限制按闭区间内每日 15:00 的预期采样时刻计算，最多 365 个；hourly 仍限制窗口最多 62 天。接口参考支持服务端固定时刻筛选，没有载明更严的 365 天跨度上限。原例 365 天加不足一天仅含 365 个计划时刻，因此接受完整原窗；第 366 个时刻仍拒绝，超长目标需分多次查询。split_time 只划分分析范围，不拆分请求，不裁剪用户窗口。
- 前端依据明确的 tool_feedback 分类忽略内部纠错过程。真正失败仍默认显示可理解的限制，可收起；提示可通过已有重新生成或继续提问补查。其他站点、其他窗口成功不会抹掉原失败。未纠错、预算耗尽仍保留真实执行状态及未覆盖说明，不生成假成功。
- 本次没有 schema 迁移或生产数据修复。回滚可使用原部署程序和已核验的上一版本；保留数据库及旧快照。

## 验证

- 独立 lma_test PostgreSQL：后端全量 187 项通过，无跳过。覆盖连续改参、原窗 365 个时刻、366 时刻及 hourly 边界、模型收到内部反馈、无错误取数证据、原 checkpoint 保留、存量伪证据不能支持目标及正式报告、报告校验、预算结束、真实权限与超时、上游数据结构异常、SSE 与历史投影一致。
- Vitest 56 项通过；调查相关 Chromium 28 项通过，包括 320px 下流式纠错、刷新恢复、真实失败的收起与另一站成功不掩盖失败。
- TypeScript 与 Vite 生产构建通过；仍有既有大 chunk 提示。git diff --check 通过。
- 参数反馈使用生产工厂与确定性模型脚本验证，没有把这些结果声称为真实模型的业务准确性评测。未进行 iPhone Safari 真机验证。

## 发布与线上核验

以最新 main 的 8799b47 为基础实施，核对主工作区干净后安全快进，保护此前新调查与测点面板交互改动。修复提交及生产版本为 `ef5ccb9969a9229967a2dd5296ad61842b82dfa3`，分支 `cindy/proud-ritchie`，已进入 main。

- [CI 42960496897](https://github.com/C-jcbest/LMA/actions/runs/42960496897) 完整通过：后端 187、Vitest 56、Chromium 52、生产构建及正常自动部署。部署回执时间为 2026-11-11 12:43:29（Asia/Shanghai）。
- 12:44 通过已配置的腾讯云连接只读确认：current、last-successful-release、后端及前端镜像均为上述完整 SHA；API healthy，公开 HTTPS 无凭据访问为 401；发布前备份 5,822,954 字节，保留于既有 backups 目录。
- 用户原调查仍为同一条成功 Run、12 条消息和同一最终回答。历史接口的旧错误现在投影为 tool_feedback，技术校验原文不再返回前端；可用证据目录由 6 项变为 5 项，排除了原误分类项。原始 checkpoint ID、全体消息、最终回答及 6 份数据库证据的 SHA-256 均与发布前完全一致，没有追加消息、删会话或改写历史。
- 生产浏览器直接访问遇到 `ERR_INVALID_AUTH_CREDENTIALS`，尚未完成该页面直接刷新后的渲染核验；需恢复现有站点 Basic Auth 登录。服务器实际历史投影已验证，修复前端的流式/刷新渲染已通过隔离浏览器回归，不将两者替代声称为生产页面目测通过。
- 本地证据（忽略入库）：backend/revision-feedback-backend.log、revision-feedback-focused.log、revision-feedback-ci.log、revision-feedback-production.log、revision-feedback-production-receipt.log；frontend/revision-feedback-vitest.log、revision-feedback-browser.log、revision-feedback-build.log。
