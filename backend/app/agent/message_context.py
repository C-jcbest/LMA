"""用户消息的服务器时间快照与依据编号，以及仅供模型读取的确定性投影。"""

import hashlib

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from app.business_time import BUSINESS_TIMEZONE, business_now
from app.agent.tool_feedback import is_tool_feedback


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
    focus_identity = kwargs.pop("lma_focus_identity", None)
    if focus_identity:
        context["focus_identity"] = focus_identity
    return message.model_copy(update={"additional_kwargs": {**kwargs, "lma_context": context}})


def evidence_id(tool_call_id: str) -> str:
    """供应商的调用 ID 又长又随机，模型难以逐字引用；短编号由它确定性派生。"""
    return "E" + hashlib.sha1(tool_call_id.encode("utf-8")).hexdigest()[:6]


# 结论登记是留档，不是可引用的观测依据。
_NON_EVIDENCE_KINDS = {"conclusions"}


def is_evidence(message: BaseMessage) -> bool:
    return (
        isinstance(message, ToolMessage)
        and isinstance(message.artifact, dict)
        and message.artifact.get("kind") not in _NON_EVIDENCE_KINDS
        and not is_tool_feedback(message)
    )


def _with_message_context(message: HumanMessage, context: dict) -> HumanMessage:
    # 每条历史消息使用自身不可变的快照；不改 system prompt 或 checkpoint 正文。
    lines = [f"sent_at: {context['sent_at']}", f"timezone: {context['timezone']}"]
    if context.get("focus_station"):
        lines.append(f"focus_station: {context['focus_station']}")
    if context.get("focus_identity"):
        lines.append(f"focus_station_uuid: {context['focus_identity']['station_uuid']}")
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


def model_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    projected = []
    for message in messages:
        context = message.additional_kwargs.get("lma_context")
        if isinstance(message, HumanMessage) and context is not None:
            projected.append(_with_message_context(message, context))
        elif isinstance(message, AIMessage) and message.invalid_tool_calls:
            # 无法解析的调用未执行，不能发给供应商成为没有结果配对的工具请求。
            # 原始输出仍留在checkpoint；模型只收到受控纠错说明及可执行的调用。
            notice = '上一条回复包含无法解析的工具参数，该部分调用未执行。请重新生成合法JSON参数，或依据已有证据直接回答。'
            content = message.content
            if isinstance(content, str):
                content = f'{content}\n\n{notice}'.strip()
            else:
                content = [*content, {'type': 'text', 'text': notice}]
            kwargs = {key: value for key, value in message.additional_kwargs.items() if key != 'tool_calls'}
            projected.append(message.model_copy(update={
                'content': content, 'invalid_tool_calls': [], 'additional_kwargs': kwargs,
            }))
        elif is_evidence(message) and isinstance(message.content, str):
            label = f'<lma_evidence id="{evidence_id(message.tool_call_id)}"/>'
            projected.append(message.model_copy(update={"content": f"{message.content}\n\n{label}"}))
        else:
            projected.append(message)
    return projected
