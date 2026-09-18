# LMA (Landslide Continuous Monitoring Agent / 滑坡连续监测智能体)

基于 LangGraph 与 `@assistant-ui/react` 构建的专业地质灾害多源监测与分析智能体平台。面向滑坡连续自动化监测场景，联动北斗 GNSS 毫米级位移时序、现场微气象与降雨实况、AI 视觉图像复核与地质/地形环境空间分析，提供自动化因果线索挖掘与趋势研判。

---

## 一、系统架构概览

```text
┌─────────────────────────────────────────────────────────────┐
│                       前端交互层 (Frontend V2)               │
│                                                             │
│  React 19 + Tailwind CSS 4 + Vite 8 + React Router 7         │
│  @assistant-ui/react + @assistant-ui/react-langchain        │
│  TanStack Query 5 (Thread Directory) + Radix UI + Sonner     │
│                                                             │
│  ┌──────────────┐   ┌────────────────────────────────────┐  │
│  │ 历史会话侧栏  │   │ 智能对话与领域渲染区                │  │
│  │ Thread       │   │ assistant-ui Thread & Composer     │  │
│  │ Sidebar      │   │ GNSS / Weather / Vision / MapLibre │  │
│  └──────────────┘   └────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ SSE 流式事件 / Checkpoint 状态恢复
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    智能体服务端 (Backend Agent Runtime)     │
│                                                             │
│  Python 3.12+ + LangGraph (create_agent) + LangGraph API    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 官方生产中间件统一装配                                  │  │
│  │ ├─ SummarizationMiddleware (800k trigger / 400k keep) │  │
│  │ ├─ ModelRetryMiddleware & ToolRetryMiddleware (退避重试)│  │
│  │ ├─ ModelCallLimitMiddleware & ToolCallLimitMiddleware │  │
│  │ └─ ToolErrorMiddleware (安全脱敏与受控错误转换)         │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 领域监测工具集 (只读与沙箱安全)                         │  │
│  │ ├─ get_daily_gnss_data (北斗 GNSS 毫米级三维位移时序) │  │
│  │ ├─ query_weather (Open-Meteo 微气象与降雨历史/预测)   │  │
│  │ ├─ list_stations / list_station_groups (测点在网健康) │  │
│  │ ├─ visual_review (Qwen 视觉多模态核查与 PNG 分析图表)  │  │
│  │ ├─ inspect_site_environment (DEM 地形坡度与地质单元)  │  │
│  │ └─ get_current_time (统一 Asia/Shanghai 业务时间锚点) │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ 状态存储与消息队列
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    基础设施与数据底座 (Docker)               │
│                                                             │
│  PostgreSQL 16 (Checkpoint / Thread / State 持久化存储)      │
│  Redis 7 (LangGraph Server 流式事件发布订阅与任务队列)       │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、前端技术栈 (Frontend V2)

- **核心运行环境**：React 19.3 + TypeScript 5.7 + Vite 8.3
- **对话组件架构**：`@assistant-ui/react` 0.15 + `@assistant-ui/react-langchain` 0.0.32
- **会话资源管理**：`@tanstack/react-query` 5.103（会话搜索、无限分页加载、重命名与删除 Mutation）
- **路由系统**：`react-router-dom` 7.18（`/chat`、`/chat/:threadId`）
- **样式与设计系统**：Tailwind CSS 4.3（使用 `@theme` semantic tokens，浅灰极简监测专业风格）
- **原子交互组件**：Radix UI + `sonner`（统一 Toast 通知）+ `lucide-react`
- **地理空间与地图**：MapLibre GL（DEM 坡度阴影与地质单元矢量图层按需加载）

---

## 三、核心设计原则

1. **唯一事实来源 (Single Source of Truth)**：
   - LangGraph Server 的 Checkpoint / Thread 为会话历史唯一事实来源，前端绝不维护第二套权威状态机。
2. **两阶段平滑数据流**：
   - 工具调用实时消费 `liveToolCall.output` 展示执行态，权威 `ToolMessage.artifact` 到达后无缝覆盖。
3. **工具返回即成功**：
   - 移除对特定供应商完成状态的硬依赖；工具执行返回即完成，空结果正常展示“该步骤没有可展示的业务数据”，杜绝伪加载假态。
4. **生命周期回归官方**：
   - Stop 操作严格调用官方 `stream.stop({ cancel: true })`；服务端在 Run 启动前自动通过 `abefore_agent` 清洗因客户端中断遗留的悬空 tool-call 消息，保障 checkpoint 内部一致性。
5. **绝对静态 Prompt Cache 与业务时间**：
   - 业务时间统一使用 `Asia/Shanghai`；System Prompt 彻底静态化，当前业务时间由 `get_current_time` 工具动态获取。

---

## 四、本地开发指南

### 1. 环境准备
- Node.js >= 20，推荐 pnpm >= 9
- Python >= 3.12
- Docker & Docker Compose (用于 PostgreSQL 与 Redis)

### 2. 后端开发环境
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 复制环境变量配置
cp .env.example .env

# 启动本地开发服务 (LangGraph CLI)
langgraph dev --port 2024
```

### 3. 前端开发环境
```powershell
cd frontend
pnpm install
pnpm run dev
# 访问 http://localhost:5173
```

---

## 五、自动化测试与质量门禁

项目遵循严苛的质量门禁标准，在任何提交前均需通过以下测试：

### 1. 后端单元与集成测试
```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py" -v
```
- 覆盖工具契约、Prompt 缓存、数据解析、视觉复核与中间件生命周期。

### 2. 前端单元与集成测试
```powershell
cd frontend
pnpm test
```
- 基于 Vitest + Testing Library，覆盖 assistant-ui V2 对话组件、监测领域渲染器、工具解码器与推理折叠。

### 3. 前端生产打包构建
```powershell
cd frontend
pnpm run build
```
- 执行完整的 TypeScript 类型检查与 Vite 生产构建。

### 4. 代码格式与排版门禁
```powershell
git diff --check
```

---

## 六、生产部署 (Docker Compose)

在生产环境中，使用 PostgreSQL 作为 Checkpoint 持久化数据库，Redis 作为消息队列：

```powershell
# 1. 在 backend/ 下生成 LangGraph 镜像
cd backend
langgraph build -t lma-agent:latest
cd ..

# 2. 启动容器编排服务
docker compose --env-file backend/.env up -d
```
服务将在宿主机 `http://localhost:2024` 暴露 API 端口。
