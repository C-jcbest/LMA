"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

import logging
import os
from functools import lru_cache

from dotenv import dotenv_values
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)
# 环境变量里带这些前缀却不是 Settings 字段的，多半是拼错或已删除的配置。
_APPLICATION_PREFIXES = (
    "LLM_", "AGENT_", "CONTEXT_", "BEIDOU_", "COMPUTE_", "TITLE_", "COMPRESS_", "AUTH_", "AMAP_", "DATABASE_",
)
# .env 里由 Compose 或第三方库读取、不属于 Settings 的变量（见 .env.example）。
_NON_SETTINGS_ENV_FILE_KEYS = {"POSTGRES_PASSWORD", "LANGSMITH_TRACING"}


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

    # 主模型 Provider 标识（deepseek/openai）；决定官方 integration 与 thinking 参数映射，不靠模型名猜测。
    llm_provider: str = "deepseek"
    # 主模型 OpenAI 兼容接口地址；标题、摘要复用此端点。
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
    # 每个 Run 的主模型逻辑调用上限（1–100，默认 15）；重试另算，最后一次调用撤掉工具让模型直接作答，下一轮重新计数。
    # 测点概览与最近巡检让状态类问题通常 1–3 次往返即可；上限决定最坏等待时间，需按真实调查的分布校准。
    agent_model_run_limit: int = Field(default=15, ge=1, le=100)
    # 每个 Run 的取数类工具调用上限（1–200，默认 20）；compute、结论登记、以往结论和最近巡检不计入，
    # 条件完全相同的重复取数直接指回已有依据也不计入。重试另算，超额调用返回 error。
    agent_tool_run_limit: int = Field(default=20, ge=1, le=200)
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

    # 访问保护的登录账号（默认 admin）。单账号，不是用户体系。
    auth_username: str = "admin"
    # 登录密码；为空时不启用访问保护（仅限本地开发与测试），生产必须配置。
    auth_password: str = ""
    # 登录 Cookie 的签名密钥，配置密码时必填，至少 32 个字符；更换后已登录的浏览器需要重新登录。
    auth_secret: str = ""


    # 官方摘要的消息 token 触发阈值（正整数，默认 160000）；使用官方计数，不采用展示估算或窗口比例。
    # 一问一会话下多轮追问也很少超过这一量级；阈值过高时摘要永不触发，而每次调用都携带全部历史，成本和延迟随之增长。
    context_token_threshold: int = Field(default=160_000, gt=0)
    # 自定义端点主模型的最大输入 token 数（必填正整数，无默认）；写入 LangChain Model Profile 供用量展示，换模型时同步修改，不决定压缩触发线。
    context_model_context: int = Field(
        gt=0
    )
    # 官方摘要后保留近期消息的 token budget（正整数，默认 48000，应小于触发阈值）；工具配对切点沿用官方规则，不是固定消息数/回合数。
    context_keep_tokens: int = Field(default=48_000, gt=0)
    # 摘要模型单次输出的 max_tokens（正整数，默认 2000）；不代表保留历史的 token budget。
    context_summary_max_tokens: int = Field(default=2000, gt=0)
    # 历史摘要模型独立思考开关（默认 false）；开关语义同 LLM_THINKING，使用当前主模型配置但不继承主模型开关。
    compress_thinking: bool = False

def _warn_unknown_settings() -> None:
    """Settings 忽略未知变量；拼错或已删除的应用配置会静默失效，这里在启动时提醒一次。"""
    known = {name.upper() for name in Settings.model_fields} | _NON_SETTINGS_ENV_FILE_KEYS
    # .env 只给本应用使用，其中所有未知键都提醒；进程环境变量很杂，只看本应用的前缀。
    from_env_file = {name for name in dotenv_values(".env") if name.upper() not in known}
    from_environment = {
        name for name in os.environ
        if name.upper().startswith(_APPLICATION_PREFIXES) and name.upper() not in known
    }
    unknown = sorted(from_env_file | from_environment)
    if unknown:
        logger.warning("ignored unknown settings (misspelled or removed): %s", ", ".join(unknown))


# 配置在进程内缓存；修改环境变量或 .env 后需重启服务才能生效。
@lru_cache
def get_settings() -> Settings:
    _warn_unknown_settings()
    return Settings()
