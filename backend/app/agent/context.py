"""上下文用量估算与展示；消息压缩由官方 SummarizationMiddleware 负责。"""

import math
from dataclasses import dataclass
from typing import Iterable

from langchain_core.messages import BaseMessage, SystemMessage
from langchain_core.messages.utils import count_tokens_approximately
from app.config import get_settings


def _estimated_message_tokens(messages: Iterable[BaseMessage], bound_tools: Iterable = ()) -> int:
    """使用 LangChain 官方近似计数器统计完整消息和工具 schema。

    兼容模型未必提供本地 tokenizer，因此预算使用近似值；单次调用完成后
    由 AIMessage.usage_metadata 向前端提供供应商返回的实际输入 token。
    """
    materialized = list(messages)
    tools = list(bound_tools)
    if not materialized and not tools:
        return 0
    factor = max(1.0, get_settings().context_token_estimate_factor)
    chars_per_token = get_settings().context_chars_per_token
    if chars_per_token <= 0:
        raise ValueError("CONTEXT_CHARS_PER_TOKEN must be greater than 0")
    return math.ceil(
        count_tokens_approximately(
            materialized,
            tools=tools or None,
            chars_per_token=chars_per_token,
            use_usage_metadata_scaling=True,
        )
        * factor
    )


@dataclass(frozen=True)
class ContextBudget:
    context_limit_tokens: int
    trigger_tokens: int
    fixed_input_tokens: int
    history_tokens: int
    available_history_tokens: int
    output_reserve_tokens: int
    safety_margin_tokens: int

    @property
    def estimated_input_tokens(self) -> int:
        return self.fixed_input_tokens + self.history_tokens

    def usage_snapshot(self, usage_metadata: dict) -> dict:
        """将供应商返回的实际 usage 与配置的模型上下文窗口组成自洽快照。"""
        limit = self.context_limit_tokens
        if limit <= 0:
            raise ValueError("CONTEXT_MODEL_CONTEXT must be greater than 0")
        input_tokens = usage_metadata.get("input_tokens")
        if not isinstance(input_tokens, int) or input_tokens < 0:
            raise ValueError("usage_metadata.input_tokens is required")
        output_tokens = usage_metadata.get("output_tokens")
        total_tokens = usage_metadata.get("total_tokens")
        reserved = input_tokens + self.output_reserve_tokens + self.safety_margin_tokens
        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens if isinstance(output_tokens, int) else None,
            "total_tokens": total_tokens if isinstance(total_tokens, int) else None,
            "context_limit_tokens": limit,
            "remaining_tokens": max(0, limit - reserved),
            "usage_ratio": min(1.0, reserved / limit),
            "trigger_tokens": self.trigger_tokens,
            "estimated_fixed_input_tokens": self.fixed_input_tokens,
            "estimated_history_tokens": self.history_tokens,
            "accounting_difference_tokens": input_tokens - self.estimated_input_tokens,
            "output_reserve_tokens": self.output_reserve_tokens,
            "safety_margin_tokens": self.safety_margin_tokens,
            "counter": "provider_reported",
            "model": get_settings().llm_model,
        }

def build_context_budget(
    messages: list[BaseMessage],
    system_prompt: str = "",
    bound_tools: Iterable = (),
) -> ContextBudget:
    """发送前进行估算：计算完整模型输入预算，判断是否到达触发线或可能超限。"""
    settings = get_settings()
    trigger = get_trigger_threshold()
    fixed_messages = [SystemMessage(content=system_prompt)] if system_prompt else []
    fixed = _estimated_message_tokens(fixed_messages, bound_tools)
    output_reserve = max(0, settings.context_output_reserve_tokens)
    safety_margin = max(0, settings.context_safety_margin_tokens)
    history_messages = list(messages)
    history = _estimated_message_tokens(history_messages)
    available = max(0, trigger - fixed - output_reserve - safety_margin)
    return ContextBudget(
        context_limit_tokens=max(0, settings.context_model_context),
        trigger_tokens=trigger,
        fixed_input_tokens=fixed,
        history_tokens=history,
        available_history_tokens=available,
        output_reserve_tokens=output_reserve,
        safety_margin_tokens=safety_margin,
    )


def get_trigger_threshold() -> int:
    """触发线：配置了模型上下文则按其百分比，同时配置时取较小值。"""
    s = get_settings()
    return min(s.context_token_threshold, int(s.context_model_context * s.context_compress_ratio))
