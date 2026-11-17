"""会话标题：根据用户的首条消息，由一次独立的模型调用提炼简洁标题。

不经过主 Agent，也不写会话 checkpoint 或历史消息。
"""

from functools import lru_cache
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.models import create_chat_model
from app.config import get_settings

SYSTEM_PROMPT = (Path(__file__).with_name("prompts") / "title.md").read_text(encoding="utf-8")

_MAX_TITLE_CHARS = 80


def clean_generated_title(value: object) -> str:
    """只做安全规范化，不按固定长度截断有意义的标题。"""
    text = str(value or "").replace("\x00", " ")
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    title = " ".join(first_line.split()).strip("\"'`“”‘’ ")
    if not title:
        return ""
    if len(title) > _MAX_TITLE_CHARS:
        prefix = title[: _MAX_TITLE_CHARS + 1]
        boundaries = [prefix.rfind(mark) for mark in "，,、：:；;。.!！?？"]
        boundary = max(boundaries)
        if boundary < 20:
            boundary = prefix.rfind(" ")
        if boundary < 20:
            return ""
        title = prefix[:boundary].strip()
    return title.rstrip("。.!！?？:：;；")


@lru_cache
def _get_title_llm():
    """标题模型独立控制思考，避免继承主 Agent 的高成本配置。"""
    settings = get_settings()
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=settings.title_thinking,
        protocol="chat_completions",
        temperature=0.3,
        max_tokens=48,
    )


async def generate_title(input_text: str) -> str:
    if not input_text.strip():
        raise ValueError("会话标题缺少首条消息")
    response = await _get_title_llm().ainvoke([
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=input_text),
    ])
    title = clean_generated_title(response.text)
    if not title:
        raise ValueError("模型未返回有效会话标题")
    return title
