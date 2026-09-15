"""官方摘要 middleware 的业务保留约束；不实现消息淘汰或摘要状态机。"""

from functools import lru_cache
from pathlib import Path

from langchain.agents.middleware import SummarizationMiddleware
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, InternalServerError, RateLimitError
from langgraph.constants import TAG_NOSTREAM

from app.agent.context import _estimated_message_tokens, build_context_budget
from app.agent.prompting import build_system_prompt
from app.agent.reasoning import thinking_options
from app.config import get_settings

SUMMARY_PROMPT = (Path(__file__).with_name("prompts") / "summary.md").read_text(encoding="utf-8")


@lru_cache
def _get_summary_model():
    settings = get_settings()
    return ChatOpenAI(
        model=settings.llm_model, api_key=settings.llm_api_key, base_url=settings.llm_base_url,
        temperature=0, max_tokens=settings.context_summary_max_tokens, max_retries=0,
        disable_streaming=True,
        **thinking_options(settings.compress_thinking),
    )


class LmaSummarizationMiddleware(SummarizationMiddleware):
    """只约束近期回合保留和错误重试，替换/配对/内部流过滤由官方实现。"""

    def __init__(self, model, *, min_turns, **kwargs):
        super().__init__(model, **kwargs)
        self.min_turns = min_turns
        # 官方默认 with_retry 会重试所有异常；改为明确的瞬时模型异常。
        self._summary_model = model.with_retry(
            retry_if_exception_type=(APIConnectionError, InternalServerError, RateLimitError,
                                     TimeoutError, ConnectionError),
            stop_after_attempt=3,
        ).with_config(tags=[TAG_NOSTREAM])

    def _determine_cutoff_index(self, messages):
        cutoff = super()._determine_cutoff_index(messages)
        user_starts = [index for index, message in enumerate(messages)
                       if message.type == "human"
                       and message.additional_kwargs.get("lc_source") != "summarization"]
        if len(user_starts) <= self.min_turns:
            return 0
        # 仅向前移动官方安全切点至完整用户回合边界，不另写淘汰算法。
        return min(cutoff, user_starts[-self.min_turns])

    async def _acreate_summary(self, messages_to_summarize):
        summary = await super()._acreate_summary(messages_to_summarize)
        if not summary.strip():
            raise ValueError("摘要模型未返回有效摘要，历史未压缩。")
        return summary


def create_summarization_middleware(model, bound_tools):
    settings = get_settings()
    budget = build_context_budget([], system_prompt=build_system_prompt(), bound_tools=bound_tools)
    if budget.available_history_tokens <= 0:
        raise ValueError("上下文触发预算不足以容纳系统提示、工具及输出预留。")
    return LmaSummarizationMiddleware(
        model, min_turns=settings.context_min_turns,
        trigger=("tokens", budget.available_history_tokens),
        keep=("messages", settings.context_keep_messages),
        token_counter=_estimated_message_tokens, summary_prompt=SUMMARY_PROMPT,
        # 不沿用官方小窗口的 4000 token 输入裁剪，保留被压缩的完整事实。
        trim_tokens_to_summarize=None,
    )
