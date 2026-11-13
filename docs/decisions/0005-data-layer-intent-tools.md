# 0005：数据层、按意图组织的工具与结论登记

- 日期：2026-11-12
- 状态：部分被取代：analyze_gnss_chart、update_plan 与 plan 依据已由 0006 删除

> 决策记录保存当时的背景与理由，是历史，不是现行规则的来源。现行架构见 [architecture.md](../architecture.md)；被取代的内容以后续记录为准。

本节取代 2026-11-10、2026-11-11 的调查目标、续查与正式报告设计：调查目标表、revision CAS、持久化证据 UUID、续查接口和带 findings 的正式报告全部删除。理由是这些簿记由模型维护，占用调用预算并拖慢回答，而前端已只展示测点状态。旧表与旧数据保留在数据库中，不再读写，迁移不删除。

- 数据层 `app/monitoring_data.py`：模型工具和测点页共用测点解析、按固定日历块分片取数（小时 30 天、每日固定时刻 360 天）、上游并发 4、观测清洗和质量统计。同一会话的数据块缓存 10 分钟，追问和重叠窗口不重复请求；缓存不是事实来源，过期即重读。运行结束关闭连接，缓存保留。
- 工具按意图组织：find_stations、get_displacement（序列与各方向特征合一，可分段、可同组共同时段对比，点数少时附逐点相对位移）、query_weather（历史最多 366 天，可选逐小时降水，预报按需）、analyze_gnss_chart（候选在已取得的小时数据上复核，不再回查平台）、inspect_site_environment、compute、update_plan、record_conclusions，以及有存储时的 get_station_history。基准站由工具直接说明，不生成失败卡片；窗口过长等可修正问题作为参数纠错返回模型。
- compute 在子进程中执行模型写的 pandas/numpy 代码，输入只来自本会话依据：语法树白名单（禁止导入、下划线属性和文件/网络入口）、受限内置函数、`python -I`、超时，Linux 上另有内存和 CPU 上限。这能挡住常见误用和注入，不等同于操作系统级沙箱；单人自托管下可接受，多用户前需复核。计算结果是 computation 依据，可被引用和再次计算；代码保存在依据中，界面不展示。
- 依据产物：位移统一为 gnss_series（含 features/comparisons/reference/quality/location），删除 numerical；新增 computation、plan、conclusions。plan 与 conclusions 不是可引用依据。
- 结论登记只校验可确定的条件（测点有依据、数据型状态有覆盖窗口的位移数据），依据自动关联本会话中该测点的全部依据，与测点结论索引同事务写入。测点调查记录在 Agent 收尾按本轮涉及的测点写入，锚点是用户提问消息。
- 存证与恢复沿用下节机制，模型不再看到存证 UUID。
