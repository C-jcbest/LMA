"""将 checkpoint 投影为 assistant-ui 官方 LangGraph 消息；不建立第二份历史。"""

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from app.agent.message_context import evidence_id, is_evidence


# 客户端只接收明确公开的字段。用白名单而不是拦截已知推理字段，
# 供应商新增内部字段时默认不外发。
_PUBLIC_CONTENT_BLOCKS = {"text", "tool_call", "tool_call_chunk", "invalid_tool_call"}
_PUBLIC_ADDITIONAL_KWARGS = {"metadata", "lc_source", "created_at"}
_PUBLIC_RESPONSE_METADATA = {"finish_reason", "model_name", "model_provider"}


def _pick(source: dict, allowed: set[str]) -> dict:
    return {key: value for key, value in source.items() if key in allowed}


def project_message(message: BaseMessage) -> dict:
    result = message.model_dump(mode="json")
    if is_evidence(message) and isinstance(result.get("artifact"), dict):
        result["artifact"]["evidence_id"] = evidence_id(message.tool_call_id)
    if isinstance(message, (AIMessage, AIMessageChunk)):
        # checkpoint 保留供应商工具协议所需的推理字段，客户端只接收公开内容。
        result["content"] = [
            block for block in message.content_blocks
            if block.get("type") in _PUBLIC_CONTENT_BLOCKS
        ]
        result["response_metadata"] = _pick(result.get("response_metadata", {}), _PUBLIC_RESPONSE_METADATA)
    kwargs = _pick(result.get("additional_kwargs", {}), _PUBLIC_ADDITIONAL_KWARGS)
    result["additional_kwargs"] = kwargs
    if kwargs.get("lc_source"):
        kwargs.setdefault("metadata", {})["lc_source"] = kwargs["lc_source"]
    return result


def project_state(values: dict) -> dict:
    messages = [project_message(message) for message in values.get("messages", [])]
    for message in reversed(messages):
        if message["type"] != "ai":
            continue
        kwargs = message.setdefault("additional_kwargs", {})
        metadata = kwargs.setdefault("metadata", {})
        metadata["lma"] = {
            "context_usage": values.get("context_usage"),
        }
        break
    return {"messages": messages}
