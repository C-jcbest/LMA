"""全局配置：从 .env 读取 LLM 与北斗平台参数。"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # 环境变量优先于当前工作目录的 .env，再采用字段默认值；忽略部署侧额外变量。
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 主模型 Provider 标识（deepseek/openai）；决定官方 integration 与 thinking 参数映射，不靠模型名猜测。
    llm_provider: str = "deepseek"
    # 主模型 OpenAI 兼容接口地址；标题、推荐、摘要复用此端点，视觉模型单独配置。
    llm_base_url: str = "https://api.deepseek.com"
    # 主模型接口密钥；标题、推荐、摘要复用。默认空值，实际调用前需配置，不提交版本库。
    llm_api_key: str = ""
    # 主模型标识，必须为配置端点支持的模型；标题、推荐、摘要复用此模型。
    llm_model: str = "deepseek-flash"
    # 主模型独立思考开关（true/false，默认 true）；Provider 层显式映射为供应商官方参数：DeepSeek 发送 thinking.type=enabled/disabled，OpenAI 不支持显式开启。
    llm_thinking: bool = True

    # 会话标题的独立思考开关（默认 false）；开关语义同 LLM_THINKING，不继承主模型开关。
    title_thinking: bool = False
    # 是否生成下一步问题建议（默认 true）；false 时跳过推荐模型调用并清空上一轮建议。
    recommend_enabled: bool = True
    # 下一步问题建议的独立思考开关（默认 false）；开关语义同 LLM_THINKING，不继承主模型开关。
    recommend_thinking: bool = False

    # 主模型/单工具瞬时失败的额外重试次数（0–5，默认 2）；含首次最多 3 次尝试，0 表示不重试。
    agent_max_retries: int = Field(default=2, ge=0, le=5)
    # 官方指数退避的初始基础延时，单位秒（0–10，默认 0.5）；倍率固定 2，0 表示不等待。
    agent_retry_initial_delay: float = Field(default=0.5, ge=0, le=10)
    # 退避基础延时上限，单位秒（0–30，默认 4）；封顶后仍有官方 ±25% 抖动，不是实际等待时间硬上限。
    agent_retry_max_delay: float = Field(default=4.0, ge=0, le=30)
    # 每个 Run 的主模型逻辑调用上限（1–100，默认 20）；重试另算，超限停止本轮，下一轮重新计数。
    agent_model_run_limit: int = Field(default=20, ge=1, le=100)
    # 每个 Run 的工具逻辑调用上限（1–200，默认 40）；重试另算，超额调用返回 error，允许的调用仍执行。
    agent_tool_run_limit: int = Field(default=40, ge=1, le=200)
    # 单次视觉工具尝试的有效候选数量上限（1–50，默认 12）；超额明确拒绝数值回查，不静默裁剪候选。
    vision_max_candidates: int = Field(default=12, ge=1, le=50)

    # 北斗监测平台 API 根地址，默认空值；使用平台工具前需配置，接口路径由客户端追加。
    beidou_api_base_url: str = ""
    # 北斗平台登录用户名，默认空值；与密码一起配置，数据访问范围由此账号的权限决定。
    beidou_username: str = ""
    # 北斗平台登录密码，默认空值；仅运行时配置，不提交版本库或转发给模型/前端。
    beidou_password: str = ""

    # 视觉模型 OpenAI 兼容端点，默认空值；与视觉密钥、模型一起配置，缺任一项则复核返回 error 并保留图表。
    # 视觉模型 Provider 标识（deepseek/openai）；与主模型独立，决定官方 integration 与 thinking 参数映射。
    vision_provider: str = "openai"
    vision_base_url: str = ""
    # 视觉模型接口密钥，默认空值；不复用主模型密钥，不提交版本库。
    vision_api_key: str = ""
    # 支持图像输入的视觉模型标识，默认空值；必须为视觉端点提供的可用模型，不复用主模型。
    vision_model: str = ""
    # 视觉模型独立思考开关（默认 false）；开关语义同 LLM_THINKING，不继承主模型开关。
    vision_thinking: bool = False
    # 候选数值核验向起止两侧各外扩的小时数（默认 2）；限制在原查询窗口内，0 不外扩，负值运行时按 0 处理。
    vision_recheck_pad_hours: int = 2

    # 官方摘要的消息 token 触发阈值（正整数，默认 800000）；使用官方计数，不采用展示估算或窗口比例。
    context_token_threshold: int = Field(default=800_000, gt=0)
    # 当前主模型上下文窗口大小，单位 token（必填正整数，无默认）；用于用量展示，换模型时同步修改，不决定压缩触发线。
    context_model_context: int = Field(
        gt=0
    )
    # 官方摘要后保留近期消息的 token budget（正整数，默认 400000）；工具配对切点沿用官方规则，不是固定消息数/回合数。
    context_keep_tokens: int = Field(default=400_000, gt=0)
    # 摘要模型单次输出的 max_tokens（正整数，默认 2000）；不代表保留历史的 token budget。
    context_summary_max_tokens: int = Field(default=2000, gt=0)
    # 用量展示为本轮输出预留的 token 数（建议非负，默认 8192）；负值运行时按 0 处理，不设置主模型输出上限或压缩规则。
    context_output_reserve_tokens: int = 8192
    # 用量展示为协议/计数误差预留的 token 数（建议非负，默认 2048）；负值运行时按 0 处理，不参与官方压缩决策。
    context_safety_margin_tokens: int = 2048
    # 展示估算的保守倍率（建议 ≥1，默认 1.1）；运行时至少按 1 计算，不改变供应商实际 usage 或官方摘要计数。
    context_token_estimate_factor: float = 1.1
    # 展示近似计数的字符/token 换算值（必须 >0，默认 1.6667）；按模型调整，非正值估算时报错，不参与官方摘要计数。
    context_chars_per_token: float = 1.6667

    # 历史摘要模型独立思考开关（默认 false）；开关语义同 LLM_THINKING，使用当前主模型配置但不继承主模型开关。
    compress_thinking: bool = False

# 配置在进程内缓存；修改环境变量或 .env 后需重启服务才能生效。
@lru_cache
def get_settings() -> Settings:
    return Settings()
