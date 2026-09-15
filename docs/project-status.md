# 项目状态与决策记录

### 2026-09-15 - 遗留界面、伪数据表达与 Prompt 权威来源收敛

- 类型：纠正 / 决策 / 完成 / 文档同步
- 范围：前端、Agent Prompt、工具契约、测试、安全、接口参考文档
- 记录：移除偏离滑坡监测业务的快捷问题、伪造用户身份、固定开发端口文案和无引用组件；GNSS 空值与非有限值统一显示为缺测并从折线取值中排除；消息时间仅展示服务端时间且按 Asia/Shanghai 格式化；站点状态只接受中文业务枚举，未知值不再套用旧数字兼容。服务配置连通性测试会精确验证 `lma-agent`，通用内部字段仅置于二次折叠的“技术详情”。
- 决策：`backend/app/agent/prompts/system.md` 与 `vision.md` 分别是业务和视觉策略唯一可编辑来源；`prompting.py` 只注入客观时间上下文与接口限制。具体窗口与同刻采样参数只在主 Prompt 中维护为可调整的默认起点，明确“只看指定时段”不得扩展，状态判断不得忽略慢速形变背景。
- 安全：北斗参考文档中的账号、密码和 SessionUUID 示例已替换为明显无效占位符；工具结果和模型输出继续按不可信数据处理，不作为默认业务 UI 或副作用输入。
- 预防：新增业务策略只写入对应正式 Prompt；工具 docstring 只说明参数、数据能力、数据源限制和返回契约；任何空值不得通过宽松数值转换伪造成 0。
- 关联：`AGENTS.md`、`业务流程说明.md`、`backend/app/agent/prompts/`、`backend/app/agent/prompting.py`、`frontend/src/components/`、`docs/reference/beidou-platform-api.md`

### 2026-09-14 - 撤回下一步建议流式预取

- 类型：纠正 / 行为回退
- 范围：主 Agent 流式输出、下一步建议、部署配置
- 记录：保留 `RECOMMEND_ENABLED` 总开关及 `RECOMMEND_THINKING` 独立思考配置；撤回“正文流达到 120 字后并行预取建议”，下一步建议恢复为主回答最终完成后生成。
- 边界：开启建议时只依据完整最终回答生成；关闭时继续清空建议并跳过建议模型调用。主回答流式回调不再创建后台建议任务。
- 预防：除非产品再次明确要求，不得依据未完成的回答前段提前生成建议，也不得恢复固定字数触发阈值。
- 关联：`prd.md`、`docs/TODO.md`、`backend/app/agent/graph.py`、`backend/app/config.py`

### 2026-09-14 - 下一步建议并行预取与总开关

- 类型：决策 / 性能优化 / 配置
- 状态：已被“撤回下一步建议流式预取”取代，仅保留为历史记录。
- 范围：主 Agent 流式输出、下一步建议、部署配置、成本控制
- 记录：新增 `RECOMMEND_ENABLED`（默认开启）。关闭时清空建议并跳过模型调用；开启时在主回答正文流达到可用长度后启动建议预取，与剩余正文生成并行，降低正文结束后的等待。
- 边界：预取只使用用户问题和已输出的回答前段；主模型若返回工具调用，必须取消或丢弃预取结果。短回答未达到预取长度时仍在回答结束后生成，以避免仅凭过短片段降低建议质量。
- 预防：不得为了即时展示而使用固定模板或伪造建议；并行任务必须跟随主模型取消，辅助 token 不得混入主消息流。
- 关联：`prd.md`、`backend/app/agent/graph.py`、`backend/app/config.py`、`backend/.env.example`

### 2026-09-14 - 辅助模型思考配置与主模型隔离

- 类型：纠正 / 配置边界 / 成本控制
- 范围：主 Agent、会话标题、下一步建议、历史压缩、视觉复核、部署配置
- 记录：`LLM_THINKING` 只控制主 Agent。标题、下一步建议、历史压缩和视觉复核分别由 `TITLE_THINKING`、`RECOMMEND_THINKING`、`COMPRESS_THINKING`、`VISION_THINKING` 控制，四项默认均为关闭。
- 行为：任何思考开关为关闭时都不发送 `enable_thinking`，不能继承或复用主模型开关；只有对应开关明确开启时才发送该供应商扩展参数。
- 预防：新增辅助 LLM 场景时必须声明独立的思考配置和默认值，不得直接读取 `LLM_THINKING`，以避免非必要延迟和 reasoning token 消耗。
- 关联：`prd.md`、`backend/app/config.py`、`backend/app/agent/reasoning.py`、`backend/.env.example`

### 2026-09-14 - 主模型思考过程可视化

- 类型：决策 / 产品行为变更 / 文档同步
- 范围：主模型配置、LangGraph 消息协议、前端会话、测试、安全
- 记录：主模型默认开启兼容接口的 `enable_thinking`；仅透传模型接口显式返回的 `reasoning_content`，按每次模型调用与工具步骤的原始顺序折叠展示，并记录该次调用墙钟耗时。展开态采用区别于最终回答的弱化排版。
- 边界：不得从系统提示词、LangGraph 状态或工具原始结果拼造思考过程；模型内容继续按不可信文本处理，不直接作为 HTML 或副作用输入。接口不支持思考参数时明确报错，不静默伪装为已启用。
- 预防：后续更换模型或供应商时，必须验证 `enable_thinking`、`reasoning_content`、流式合并与 checkpoint 恢复四项契约。
- 关联：`prd.md`、`backend/app/agent/reasoning.py`、`backend/app/agent/graph.py`、`frontend/src/services/api.ts`、`frontend/src/components/ThinkingBlock.tsx`

### 2026-09-14 - 兼容分支与兜底策略必须先告知

- 类型：纠正 / 长期实现约束
- 范围：前后端错误处理、兼容代码、降级与兜底展示
- 记录：新增兼容性分支或兜底策略前，必须先说明触发条件、可见结果和误导风险；若不设置会导致数据丢失、会话损坏或其他风险，需用户明确同意后再实现。
- 禁止：不得以伪造进度、技术 ID 标题、本地假成功或模板化建议掩盖配置缺失、请求失败或状态不确定。
- 预期行为：可验证的错误应显式呈现；暂时未取得新状态时，保留上一个已确认状态。
- 本轮清理：移除本地会话假数据/假成功、技术工具名补造、标题静默成功、正则/模板推荐、非法采样频率默认每小时、剪贴板弃用 API 降级；错误分别由界面或工具结果明确呈现。
- 保留的数据保护：压缩失败或只剩最近两段时不删除 checkpoint；工具输出超硬上限时抽稀并在 `sampling/downsampled/notes` 中披露；瞬时工具失败按既有重试策略耗尽后写入明确错误。这些路径不伪造事实。
- 待用户决定：未配置独立压缩模型时复用主模型是既有策略；直接移除可能导致长会话无法压缩，本轮不改变。如需取消，应先确定“禁用压缩”还是“强制独立模型配置”。
- 安全修复：新增 `backend/.dockerignore`，排除 `.env`、虚拟环境、测试和调试文件；当前 agent 镜像已重建并确认不含 `/deps/outer-backend/src/.env`。
- 关联：`AGENTS.md`、`docs/TODO.md`、`prd.md`

### 2026-09-14 - TODO 17–18 交互收敛与上下文用量完成

- 类型：完成 / 规范对齐 / 稳定性修复
- 范围：LangGraph 上下文、Run 取消、会话创建、推荐动作、地图 Marker、前端用量面板
- 记录：每次主模型调用完成后使用 `AIMessage.usage_metadata` 实际用量；LangChain `count_tokens_approximately` 仅用于系统提示、工具 schema、历史与摘要的分项预算，并记录与实际输入的核算差值。新增持久化 `context_usage` 及输入框环形明细入口。同时修复 Marker 跨界、首轮重复 Thread/技术标题闪现，并在 interrupt 取消等待收敛后才闭合未完成 tool_call。
- 证据边界：模型窗口配置缺失或非法时启动报错；缺少真实 usage 或旧 checkpoint 时不显示上下文入口。下一步建议仅由模型判断适用性，生成或校验失败显式报错，不使用正则和固定模板降级；取消补齐只使用 checkpoint 中已有的 tool_call id。
- 验证：以本次实现完成后的自动化测试、生产构建和差异检查结果为准。
- 关联：`docs/TODO.md`、`prd.md`、`backend/app/agent/context.py`、`backend/app/agent/graph.py`、`frontend/src/App.tsx`、`frontend/src/components/ContextUsageIndicator.tsx`

### 2026-09-14 - TODO 14–16 交互回归与地图修复完成

- 类型：完成 / 纠正 / 测试基线
- 范围：前端会话、LangGraph checkpoint、地图、测试、产品文档
- 记录：修复推荐动作晚到不可见、回到底部位置、标题轮询闪现技术名、取消后工具调用悬挂及下一轮协议错误；地图测点改为独立 DOM Marker，展开态改为可通过按钮、遮罩和 Esc 关闭的全屏浮层，并提高初始缩放、补充监测人员关注信息。
- 安全边界：取消收尾只写入与服务端已发出 tool_call id 对应的结构化 ToolMessage；地图弹窗使用 textContent 构造，不把站点或模型文本作为 HTML；远程图层地址仍为代码内受信配置。
- 验证：后端 15 项单元测试通过；前端 4 项会话集成测试通过；TypeScript 与 Vite 生产构建通过；真实浏览器确认 4 个 Marker、全屏地图、右上角关闭与 Esc 关闭正常。真实模型措辞、上游数据和外部瓦片继续由部署环境验收。
- 关联：`docs/TODO.md`、`prd.md`、`frontend/src/App.tsx`、`frontend/src/services/api.ts`、`frontend/src/components/ChatWindow.tsx`、`frontend/src/components/SiteEnvironmentCard.tsx`、`frontend/tests/conversation.integration.test.tsx`

### 2026-09-14 - TODO 8–13 实施完成

- 类型：完成 / 前后端能力升级
- 范围：LangGraph 流式会话、工具重试、上下文预算、站点空间字段、标题、内联地图
- 记录：前端已由 `@langchain/react useStream` 直接投影 Thread 权威消息，移除手工流缓冲与 Run 引用；工具节点只重试超时、连接、HTTP 429/5xx，并在耗尽后向智能体返回可解释的 ToolMessage；上下文预算已纳入动态系统提示、工具 schema、输出预留与安全余量；站点输出补齐 WGS84 经纬度和海拔；标题不再使用固定意图模板或破坏性截断；新增版本化 `site_environment` 工具结果与惰性 MapLibre 地图卡片。
- 证据边界：地图使用代码内固定的受信瓦片源；Open-Meteo/Copernicus DEM 与 Macrostrat 图层均显示来源。Macrostrat 公开能力不足以可靠计算最近断层距离，因此仅展示构造线并明确缺失，不做模型补写。
- 验证：后端 15 项单元测试通过；上下文脚本 18 项自测通过；前端 TypeScript 与 Vite 生产构建通过；`git diff --check` 通过。
- 关联：`docs/TODO.md`、`backend/app/agent/graph.py`、`backend/app/agent/site.py`、`frontend/src/App.tsx`、`frontend/src/components/SiteEnvironmentCard.tsx`

### 2026-09-14 - 保持智能体灵活性

- 类型：纠正 / 约束 / 文档同步
- 范围：智能体、提示词、工具编排、前后端、测试
- 记录：智能体应根据用户意图、上下文与实际证据动态选择分析路径和回答结构；不得通过固定模板、固定章节或固定工具调用顺序填充结果，导致行为僵化。
- 边界：灵活性不覆盖安全和事实约束。平台事实需由工具获取，外部内容和模型输出均不可信，高风险结论保持证据边界，工具维持最小权限。
- 预防：评审提示词和编排变更时，检查新增内容是“目标/边界/可选策略”还是“强制脚本”；除接口 schema 和安全校验外，优先删除不必要的固定格式与固定流程。
- 关联：`AGENTS.md`、`docs/TODO.md`、`prd.md`

### 2026-09-14 - TODO 8–13 形成实施方案

- 类型：状态 / 决策
- 范围：前端、后端、智能体、地图、测试
- 记录：第 8–13 项均已补充依赖关系、增量方案和验收标准，但尚未标记为完成。
- 预防：只能在实现、回归测试和文档同步全部完成后，将对应事项改为“已完成”。
- 关联：`docs/TODO.md`
