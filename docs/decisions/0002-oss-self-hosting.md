# 0002：免费 OSS 自托管、消息白名单、结论登记结束本轮与批量巡检

- 日期：2026-11-09
- 状态：有效

> 决策记录保存当时的背景与理由，是历史，不是现行规则的来源。现行架构见 [architecture.md](../architecture.md)；被取代的内容以后续记录为准。

采用 FastAPI + 官方 PostgreSQL Checkpointer 替代商业 Agent Server；无需 LangSmith Deployment 许可。固定单 worker，重启后的未完成 Run 标记 interrupted，不自动重放。前端继续使用官方 Runtime，不复制会话历史；用户选择重新生成后仅显示最新回答，旧 checkpoint 留存，不提供分支切换。CI/CD、IP HTTPS、访问保护与部署限制见[部署说明](../deployment.md)。

对外消息统一经过 server/messages.py：流式与历史按白名单输出公开内容块和字段；checkpoint 内保留多轮工具协议需要的推理字段。不注册时间查询工具。模型提供方的缓存验证只断言历史输入前缀稳定，不以此宣称提供方缓存命中率。新调查推荐采用下述独立的应用内结果缓存。

结论登记（record_conclusions）是带 ToolRuntime 的普通工具，校验失败返回错误由模型修正；登记成功且同一条模型回复已有正文时，由 LmaMiddleware 的 `jump_to: end` 结束本轮，没有正文则回到模型补写。不用官方 `return_direct`，它在工具失败时同样结束，模型无法修正。依据编号在模型调用边界由 tool_call_id 确定性派生，不写入 checkpoint 正文，是全系统唯一的依据编号。

批量巡检在单 worker 内以 asyncio 任务运行，上游并发固定为 4，结果写入 lma_inspections 和 lma_inspection_stations；进程重启时进行中的巡检标记为 interrupted，不自动重放。初筛规则集中在 app/inspection/screening.py，不调用模型。

前端不再为工具注册逐个 Renderer：GroupedParts 把一条消息的工具调用归为一个调查过程，依据按测点从官方 tool part 的 artifact 派生，不复制到前端状态。时间轴使用按需加载的 ECharts，同轴、缺测带、联动和缩放由图表库完成，不自建绘图逻辑；颜色全部来自 CSS 变量。主题默认跟随系统，可手动选择浅色或深色。主题、导航折叠和面板宽度只保存在当前浏览器；窄屏临时收窄或全屏显示，不覆盖桌面宽度偏好。拖动按帧修改 CSS 尺寸，操作结束才保存；不复制会话历史或滚动状态。
