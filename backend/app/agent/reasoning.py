"""保留 OpenAI 兼容接口显式返回的模型思考内容。

langchain-openai 的 Chat Completions 转换器只处理 OpenAI 标准字段，会忽略
DeepSeek/Qwen 等兼容接口放在 ``reasoning_content`` 中的内容。本模块在不改变
正文、工具调用和 usage 语义的前提下，将该字段放入 AIMessage.additional_kwargs，
使 LangGraph checkpoint 与 messages 流都能按原顺序携带它。
"""

from typing import Any

from langchain_openai import ChatOpenAI


def thinking_options(enabled: bool) -> dict[str, dict[str, bool]]:
    """仅在明确开启时发送供应商扩展参数，关闭时保持标准 OpenAI 请求。"""
    return {"extra_body": {"enable_thinking": True}} if enabled else {}


def _response_dict(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        return response
    model_dump = getattr(response, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(warnings=False)
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _reasoning_from_choice(choice: Any, field: str) -> str:
    if not isinstance(choice, dict):
        return ""
    payload = choice.get(field)
    if not isinstance(payload, dict):
        return ""
    reasoning = (
        payload.get("reasoning_content")
        or payload.get("reasoning")
        or payload.get("thinking")
    )
    return reasoning if isinstance(reasoning, str) else ""


class ReasoningChatOpenAI(ChatOpenAI):
    """ChatOpenAI 的窄适配：仅透传供应商显式返回的 reasoning_content。"""

    def _create_chat_result(self, response: Any, generation_info: dict | None = None):
        response_data = _response_dict(response)
        result = super()._create_chat_result(response, generation_info)
        choices = response_data.get("choices")
        if not isinstance(choices, list):
            return result

        for generation, choice in zip(result.generations, choices, strict=False):
            reasoning = _reasoning_from_choice(choice, "message")
            if reasoning:
                generation.message.additional_kwargs["reasoning_content"] = reasoning
                generation.message.response_metadata["reasoning_content"] = reasoning
        return result

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ):
        generation_chunk = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation_chunk is None:
            return None

        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
        if choices:
            reasoning = _reasoning_from_choice(choices[0], "delta")
            if reasoning:
                generation_chunk.message.additional_kwargs["reasoning_content"] = reasoning
                generation_chunk.message.response_metadata["reasoning_content"] = reasoning
        return generation_chunk
