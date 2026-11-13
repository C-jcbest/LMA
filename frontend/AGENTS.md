# 前端约定

通用规则见根目录 [AGENTS.md](../AGENTS.md)，架构边界见 [当前架构](../docs/architecture.md)，测试分工见 [开发指南](../docs/development.md#验证)。

- 使用 pnpm；单元测试 `pnpm test`，类型检查与构建 `pnpm build`，浏览器测试 `pnpm exec playwright test e2e/<文件>.spec.ts`（需要 LMA_TEST_DATABASE_URI 指向 lma_test）。
- 只用 assistant-ui / LangChain 的公开 API；会话历史以服务端 checkpoint 为准，前端不复制消息或工具状态。
- 工具结果只从 artifact 读取，并在 src/features/monitoring/artifacts.ts 集中校验；不解析模型侧 content。
- 颜色来自 CSS 变量；地图坐标只在展示边界由 WGS84 转 GCJ-02，非法坐标不绘制、不交换经纬度。
- 临时探针测试和截图放在系统临时目录，不提交；完成后删除 e2e 下的临时 spec。
