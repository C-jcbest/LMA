"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # LLM（OpenAI 兼容 API）
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    # 北斗监测平台（当前为测试账号，后续迭代改为用户绑定凭据）
    beidou_api_base_url: str = "http://39.96.80.62/bdjc-api/v2/API"
    beidou_username: str = ""
    beidou_password: str = ""

    # 视觉模型（OpenAI 兼容 API，用于 GNSS 图表形态复核，不配置则视觉工具降级）
    vision_base_url: str = ""
    vision_api_key: str = ""
    vision_model: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
