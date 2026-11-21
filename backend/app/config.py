"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_uri: str = ""
    database_pool_size: int = Field(default=6, ge=2, le=20)
    cors_origins: str = ""

    langfuse_enabled: bool = False
    langfuse_base_url: str = ""
    langfuse_public_key: str = Field(default="", repr=False)
    langfuse_secret_key: str = Field(default="", repr=False)
    langfuse_tracing_environment: str = Field(default="development", pattern=r"^[a-z0-9_-]+$")

    llm_provider: str = "deepseek"
    llm_base_url: str = "https://api.deepseek.com"
    llm_api_key: str = ""
    llm_model: str = "deepseek-flash"
    llm_thinking: bool = True

    title_thinking: bool = False
    agent_max_retries: int = Field(default=2, ge=0, le=5)
    agent_retry_initial_delay: float = Field(default=0.5, ge=0, le=10)
    agent_retry_max_delay: float = Field(default=4.0, ge=0, le=30)
    agent_model_run_limit: int = Field(default=30, ge=1, le=100)
    agent_tool_run_limit: int = Field(default=40, ge=1, le=200)
    agent_inline_points_limit: int = Field(default=72, ge=0, le=1000)
    compute_timeout_seconds: float = Field(default=10.0, ge=1, le=60)

    beidou_api_base_url: str = ""
    beidou_username: str = ""
    beidou_password: str = ""

    amap_token: str = ""

    vision_provider: str = "openai"
    vision_protocol: Literal["responses", "chat_completions"] = "chat_completions"
    vision_base_url: str = ""
    vision_api_key: str = Field(default="", repr=False)
    vision_model: str = ""
    vision_thinking: bool = False

    auth_username: str = "admin"
    auth_password: str = ""
    auth_secret: str = ""


    context_token_threshold: int = Field(default=800_000, gt=0)
    context_model_context: int = Field(
        gt=0
    )
    context_keep_tokens: int = Field(default=400_000, gt=0)
    context_summary_max_tokens: int = Field(default=2000, gt=0)
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

@lru_cache
def get_settings() -> Settings:
    return Settings()
