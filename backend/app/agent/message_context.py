"""用户消息的服务器时间快照与依据编号，以及仅供模型读取的确定性投影。"""

import hashlib

from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage

from app.business_time import BUSINESS_TIMEZONE, business_now


# 接口层写入、发送时并入快照的临时字段：用户提问时正在查看的测点。
FOCUS_STATION_KEY = "lma_focus_station"


def stamp_user_message(message: HumanMessage) -> HumanMessage:
    if "lma_context" in message.additional_kwargs:
        return message
    context = {
        "sent_at": business_now().isoformat(timespec="seconds"),
        "timezone": BUSINESS_TIMEZONE,
    }
    kwargs = dict(message.additional_kwargs)
    focus_station = kwargs.pop(FOCUS_STATION_KEY, None)
    if focus_station:
        context["focus_station"] = focus_station
    return message.model_copy(update={"additional_kwargs": {**kwargs, "lma_context": context}})


def evidence_id(tool_call_id: str) -> str:
    """供应商的调用 ID 又长又随机，模型难以逐字引用；短编号由它确定性派生。"""
    return "E" + hashlib.sha1(tool_call_id.encode("utf-8")).hexdigest()[:6]


def is_evidence(message: BaseMessage) -> bool:
    return isinstance(message, ToolMessage) and message.status != "error" and message.artifact is not None


def _with_message_context(message: HumanMessage, context: dict) -> HumanMessage:
    # 每条历史消息使用自身不可变的快照；不改 system prompt 或 checkpoint 正文。
    lines = [f"sent_at: {context['sent_at']}", f"timezone: {context['timezone']}"]
    if context.get("focus_station"):
        lines.append(f"focus_station: {context['focus_station']}")
    metadata = "<lma_message_context>\n" + "\n".join(lines) + "\n</lma_message_context>"
    content = message.content
    if isinstance(content, str):
        content = f"{metadata}\n\n{content}"
    else:
        content = [{"type": "text", "text": metadata}, *content]
    kwargs = {
        key: value for key, value in message.additional_kwargs.items()
        if key != "lma_context"
    }
    return message.model_copy(update={"content": content, "additional_kwargs": kwargs})


def model_messages(messages: list[BaseMessage], *, persistent_evidence: dict[str, str] | None = None) -> list[BaseMessage]:
    projected = []
    for message in messages:
        context = message.additional_kwargs.get("lma_context")
        if isinstance(message, HumanMessage) and context is not None:
            projected.append(_with_message_context(message, context))
        elif is_evidence(message) and isinstance(message.content, str):
            label = f'<lma_evidence id="{evidence_id(message.tool_call_id)}"/>'
            persisted_uuid = (persistent_evidence or {}).get(message.tool_call_id)
            if persisted_uuid is not None:
                label += f'\n<lma_persisted_evidence uuid="{persisted_uuid}"/>'
            projected.append(message.model_copy(update={"content": f"{message.content}\n\n{label}"}))
        else:
            projected.append(message)
    return projected
