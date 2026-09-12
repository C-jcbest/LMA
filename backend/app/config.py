"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # LLM（OpenAI 兼容 API）
    llm_base_url: str = "https://api.deepseek.com"
    llm_api_key: str = ""
    llm_model: str = "deepseek-flash"

    # 北斗监测平台（当前为测试账号，后续迭代改为用户绑定凭据）
    beidou_api_base_url: str = ""
    beidou_username: str = ""
    beidou_password: str = ""

    # 视觉模型（OpenAI 兼容 API，用于 GNSS 图表形态复核，不配置则视觉工具降级）
    vision_base_url: str = ""
    vision_api_key: str = ""
    vision_model: str = ""
    # 视觉模型思考开关：以 extra_body {"enable_thinking": ...} 下发，
    # 适配 Qwen3 系列等支持该参数的 OpenAI 兼容 API；关闭可降低延迟与
    # reasoning token 消耗，其他平台不识别该参数时通常忽略
    vision_thinking: bool = False
    # 视觉定位异常区间的数值核验外扩小时数：视觉估读时间存在误差，
    # 向两侧外扩可避免边界关键数据被截掉；0 表示不外扩
    vision_recheck_pad_hours: int = 2

    # 上下文管理（token 驱动，无轮数窗口）
    # 触发线 = min(token_threshold, model_context * compress_ratio)，超线才压缩
    context_token_threshold: int = 800_000  # 绝对触发线，适配百万级上下文模型
    context_model_context: int = 0  # 主 LLM 上下文窗口 token 数，>0 时按百分比触发
    context_compress_ratio: float = 0.8  # 模型上下文的触发百分比
    context_target_ratio: float = 0.5  # 压缩后目标水位（触发线的比例）
    context_min_turns: int = 2  # 最少保留对话段数（兜底）
    context_summary_max_tokens: int = 2000  # 摘要长度上限

    # 压缩模型（OpenAI 兼容，不配置则复用主 LLM）
    compress_base_url: str = ""
    compress_api_key: str = ""
    compress_model: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
