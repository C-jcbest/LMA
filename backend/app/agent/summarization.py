"""官方摘要配置：token 阈值触发、token budget 保留，不覆写内部逻辑。"""

from functools import lru_cache
from pathlib import Path

from langchain.agents.middleware import SummarizationMiddleware
from langgraph.constants import TAG_NOSTREAM

from app.agent.models import create_chat_model
from app.config import get_settings

SUMMARY_PROMPT = (Path(__file__).with_name("prompts") / "summary.md").read_text(encoding="utf-8")


@lru_cache
def _get_summary_model():
    settings = get_settings()
    return create_chat_model(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        thinking=settings.compress_thinking,
        temperature=0,
        max_tokens=settings.context_summary_max_tokens,
        disable_streaming=True, tags=[TAG_NOSTREAM],
    )


def create_summarization_middleware(model):
    settings = get_settings()
    return SummarizationMiddleware(
        model=model,
        trigger=("tokens", settings.context_token_threshold),
        keep=("tokens", settings.context_keep_tokens),
        summary_prompt=SUMMARY_PROMPT,
        trim_tokens_to_summarize=None,
    )
