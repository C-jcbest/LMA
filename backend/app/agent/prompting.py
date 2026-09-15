"""加载随 backend 一起部署的提示词，并注入每回合业务时间。"""

from datetime import datetime, timedelta
from pathlib import Path

from app.business_time import BUSINESS_TZ, TIME_FORMAT, business_now

_PROMPT_DIR = Path(__file__).with_name("prompts")
SYSTEM_PROMPT_TEMPLATE = (_PROMPT_DIR / "system.md").read_text(encoding="utf-8")
VISION_PROMPT = (_PROMPT_DIR / "vision.md").read_text(encoding="utf-8")


def _resolve_time(value: str | None) -> datetime:
    if value is None:
        return business_now()
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError("业务时间锚点必须包含 UTC 偏移")
    return dt.astimezone(BUSINESS_TZ)


def build_time_context(value: str | None = None) -> str:
    now = _resolve_time(value)
    fmt = lambda dt: dt.strftime(TIME_FORMAT)
    return f"""【本回合时间上下文】
当前业务时间：{fmt(now)}；业务时区：Asia/Shanghai（UTC+08:00）。
“今天”：{fmt(now.replace(hour=0, minute=0, second=0))} 至 {fmt(now)}。
“昨天”：{(now - timedelta(days=1)).date().isoformat()}。
相对日期以本回合时间为准，不沿用历史对话中的“今天”；已明确的历史绝对时间不随当前日期移动。
GNSS 和图表参数使用 Asia/Shanghai 本地时间 YYYY-MM-DD HH:mm:ss，天气日期使用同一时区 YYYY-MM-DD。
不要将当前时间当作最新数据时间；需检查实际返回的数据起止时间与缺测情况。
天气历史接口最多到昨天、单次最多 31 天；今天的天气参考当前/预报数据并说明性质，不能冒充完整历史实测。
"""


def build_system_prompt(value: str | None = None) -> str:
    now = _resolve_time(value)
    # 仅替换已知占位符，避免视觉 JSON 等花括号被格式化解释。
    prompt = SYSTEM_PROMPT_TEMPLATE.replace("{{CURRENT_TIME}}", now.strftime(TIME_FORMAT))
    return prompt + "\n\n" + build_time_context(now.isoformat())
