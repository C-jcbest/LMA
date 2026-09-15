"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # LLM（OpenAI 兼容 API）
    llm_base_url: str = "https://api.deepseek.com"
    llm_api_key: str = ""
    llm_model: str = "deepseek-flash"
    # 主模型思考开关：适用于通过 reasoning_content 返回思考过程的
    # OpenAI 兼容接口。平台不支持该参数时由接口明确报错，不静默降级。
    llm_thinking: bool = True

    # 辅助模型调用分别控制思考，均默认关闭，不能继承主模型开关。
    title_thinking: bool = False
    recommend_enabled: bool = True
    recommend_thinking: bool = False

    # 北斗监测平台（当前为测试账号，后续迭代改为用户绑定凭据）
    beidou_api_base_url: str = ""
    beidou_username: str = ""
    beidou_password: str = ""

    # 视觉模型（OpenAI 兼容 API，用于 GNSS 图表形态复核，不配置则视觉工具降级）
    vision_base_url: str = ""
    vision_api_key: str = ""
    vision_model: str = ""
    # 视觉模型独立思考开关：仅开启时通过 extra_body 下发 enable_thinking，
    # 适配支持该参数的 OpenAI 兼容 API；关闭时不发送扩展字段。
    vision_thinking: bool = False
    # 视觉定位异常区间的数值核验外扩小时数：视觉估读时间存在误差，
    # 向两侧外扩可避免边界关键数据被截掉；0 表示不外扩
    vision_recheck_pad_hours: int = 2

    # 上下文管理（token 驱动，无轮数窗口）
    # 官方 middleware 按消息 token 阈值触发，按 token budget 保留近期上下文
    context_token_threshold: int = Field(default=800_000, gt=0)  # 绝对触发线，适配百万级上下文模型
    context_model_context: int = Field(
        gt=0
    )  # 必须按当前模型配置；DeepSeek V4 Flash 官方窗口为 1_048_576
    context_keep_tokens: int = Field(default=400_000, gt=0)  # 官方近期消息 token budget
    context_summary_max_tokens: int = Field(default=2000, gt=0)  # 摘要长度上限
    context_output_reserve_tokens: int = 8192  # 为本轮模型输出预留
    context_safety_margin_tokens: int = 2048  # tokenizer 误差与协议开销余量
    context_token_estimate_factor: float = 1.1  # OpenAI 兼容模型的保守估算系数
    context_chars_per_token: float = 1.6667  # DeepSeek 官方参考：1 中文字符约 0.6 token

    # 摘要使用当前 LLM 的模型/端点/密钥，思考开关独立。
    compress_thinking: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
