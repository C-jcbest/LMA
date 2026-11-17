"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # 环境变量优先于当前工作目录的 .env，再采用字段默认值；忽略部署侧额外变量。
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 自托管服务 PostgreSQL 连接串；服务启动与迁移必填，无默认数据库，不影响纯 Agent 单元测试。
    database_uri: str = ""
    # 服务数据库连接池上限（2–20，默认 6，单位连接）；单个 Uvicorn worker 生效。
    database_pool_size: int = Field(default=6, ge=2, le=20)
    # 允许跨源访问的前端 Origin，逗号分隔；默认空值仅同源，开发跨端口时显式配置。
    cors_origins: str = ""

    # Langfuse 调用链追踪，默认关闭；开启后向显式配置的项目发送调查内容。
    langfuse_enabled: bool = False
    # Langfuse 项目的区域根地址，开启追踪时必填；不自动选择数据区域。
    langfuse_base_url: str = ""
    # Langfuse 项目 API 公钥与私钥，仅用于后端追踪；不提交版本库或发往客户端。
    langfuse_public_key: str = Field(default="", repr=False)
    langfuse_secret_key: str = Field(default="", repr=False)
    # 追踪环境标识，默认 development；生产设为 production，与业务数据存储相互独立。
    langfuse_tracing_environment: str = Field(default="development", pattern=r"^[a-z0-9_-]+$")

    # 主模型 Provider 标识（deepseek/openai）；决定官方 integration 与 thinking 参数映射，不靠模型名猜测。
    llm_provider: str = "deepseek"
    # 主模型 OpenAI 兼容接口地址；标题、摘要、问题推荐复用此端点。
    llm_base_url: str = "https://api.deepseek.com"
    # 主模型接口密钥；标题、摘要复用。默认空值，实际调用前需配置，不提交版本库。
    llm_api_key: str = ""
    # 主模型标识，必须为配置端点支持的模型；标题、摘要复用此模型。
    llm_model: str = "deepseek-flash"
    # 主模型独立思考开关（true/false，默认 true）；Provider 层显式映射为供应商官方参数：DeepSeek 发送 thinking.type=enabled/disabled，OpenAI 官方 integration 使用 Responses API 与 reasoning 参数控制。
    llm_thinking: bool = True

    # 会话标题的独立思考开关（默认 false）；开关语义同 LLM_THINKING，不继承主模型开关。
    title_thinking: bool = False
    # 主模型/单工具瞬时失败的额外重试次数（0–5，默认 2）；含首次最多 3 次尝试，0 表示不重试。
    agent_max_retries: int = Field(default=2, ge=0, le=5)
    # 官方指数退避的初始基础延时，单位秒（0–10，默认 0.5）；倍率固定 2，0 表示不等待。
    agent_retry_initial_delay: float = Field(default=0.5, ge=0, le=10)
    # 退避基础延时上限，单位秒（0–30，默认 4）；封顶后仍有官方 ±25% 抖动，不是实际等待时间硬上限。
    agent_retry_max_delay: float = Field(default=4.0, ge=0, le=30)
    # 每个 Run 的主模型逻辑调用上限（1–100，默认 30）；重试另算，最后一次调用撤掉工具让模型直接作答，下一轮重新计数。
    agent_model_run_limit: int = Field(default=30, ge=1, le=100)
    # 每个 Run 的取数类工具调用上限（1–200，默认 40）；compute、结论登记和读取以往结论不计入。重试另算，超额调用返回 error。
    agent_tool_run_limit: int = Field(default=40, ge=1, le=200)
    # 位移结果自动附带逐点数据的点数上限（0–1000，默认 72，约 3 天小时数据）；超过时只给特征，模型可显式要求或用 compute。
    # 逐点数据会随每次模型调用重复发送，设得过大时多测点调查的输入 token 成倍增长。
    agent_inline_points_limit: int = Field(default=72, ge=0, le=1000)
    # compute 单次计算的运行时间上限，单位秒（1–60，默认 10）；超时终止子进程并返回错误。
    compute_timeout_seconds: float = Field(default=10.0, ge=1, le=60)

    # 北斗监测平台 API 根地址，默认空值；使用平台工具前需配置，接口路径由客户端追加。
    beidou_api_base_url: str = ""
    # 北斗平台登录用户名，默认空值；与密码一起配置，数据访问范围由此账号的权限决定。
    beidou_username: str = ""
    # 北斗平台登录密码，默认空值；仅运行时配置，不提交版本库或转发给模型/前端。
    beidou_password: str = ""

    # 高德 JavaScript API 密钥，运行时下发至已登录浏览器；需配置部署域名白名单。
    amap_token: str = ""

    # 巡检原型的视觉模型 Provider（openai/deepseek，默认 openai）；只用于“巡检原型”页对建议调查测点的形态初判。
    vision_provider: str = "openai"
    # 视觉模型调用协议：responses 或 chat_completions（默认 chat_completions）；按供应商实际支持的接口填写。
    vision_protocol: Literal["responses", "chat_completions"] = "chat_completions"
    # 视觉模型 OpenAI 兼容接口地址；为空时原型只给初筛结果，不调用视觉模型。
    vision_base_url: str = ""
    # 视觉模型接口密钥，不提交版本库或下发给前端。
    vision_api_key: str = Field(default="", repr=False)
    # 视觉模型标识，必须支持图片输入；为空时不调用视觉模型。
    vision_model: str = ""
    # 视觉模型独立思考开关（默认 false）；开启会显著增加每个测点的等待时间。
    vision_thinking: bool = False

    # 访问保护的登录账号（默认 admin）。单账号，不是用户体系。
    auth_username: str = "admin"
    # 登录密码；为空时不启用访问保护（仅限本地开发与测试），生产必须配置。
    auth_password: str = ""
    # 登录 Cookie 的签名密钥，配置密码时必填，至少 32 个字符；更换后已登录的浏览器需要重新登录。
    auth_secret: str = ""


    # 官方摘要的消息 token 触发阈值（正整数，默认 800000）；使用官方计数，须小于模型最大输入 token 数，创建 Agent 时校验。
    context_token_threshold: int = Field(default=800_000, gt=0)
    # 主模型的最大输入 token 数（必填正整数，无默认）；仅在官方 Model Profile 缺少该值时补入，用于用量展示和摘要阈值校验，换模型时同步修改。
    context_model_context: int = Field(
        gt=0
    )
    # 官方摘要后保留近期消息的 token budget（正整数，默认 400000，须小于触发阈值）；工具配对切点沿用官方规则，不是固定消息数/回合数。
    context_keep_tokens: int = Field(default=400_000, gt=0)
    # 摘要模型单次输出的 max_tokens（正整数，默认 2000）；不代表保留历史的 token budget。
    context_summary_max_tokens: int = Field(default=2000, gt=0)
    # 历史摘要模型独立思考开关（默认 false）；开关语义同 LLM_THINKING，使用当前主模型配置但不继承主模型开关。
    compress_thinking: bool = False

    @model_validator(mode="after")
    def validate_langfuse(self):
        if self.langfuse_tracing_environment.startswith("langfuse"):
            raise ValueError("LANGFUSE_TRACING_ENVIRONMENT 不能以 langfuse 开头。")
        if self.langfuse_enabled and not (
            self.langfuse_base_url and self.langfuse_public_key and self.langfuse_secret_key
        ):
            raise ValueError("开启 Langfuse 必须配置 LANGFUSE_BASE_URL、LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY。")
        if self.langfuse_base_url:
            url = AnyHttpUrl(self.langfuse_base_url)
            if url.username or url.password or url.query or url.fragment:
                raise ValueError("LANGFUSE_BASE_URL 不得含账号、密码、查询参数或片段。")
        return self

# 配置在进程内缓存；修改环境变量或 .env 后需重启服务才能生效。
@lru_cache
def get_settings() -> Settings:
    return Settings()
