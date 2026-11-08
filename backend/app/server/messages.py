"""将 checkpoint 投影为 assistant-ui 官方 LangGraph 消息；不建立第二份历史。"""

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage


def project_message(message: BaseMessage) -> dict:
    result = message.model_dump(mode="json")
    if isinstance(message, (AIMessage, AIMessageChunk)):
        # 使用 LangChain 标准 content_blocks，统一 DeepSeek/OpenAI 的 reasoning。
        result["content"] = message.content_blocks
    kwargs = result.get("additional_kwargs", {})
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
            "recommendations": values.get("recommendations", []),
            "recommendations_error": values.get("recommendations_error", ""),
        }
        break
    return {"messages": messages}
