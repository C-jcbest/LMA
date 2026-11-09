"""用户消息的服务器时间快照，以及仅供模型读取的确定性投影。"""

from langchain_core.messages import BaseMessage, HumanMessage

from app.business_time import BUSINESS_TIMEZONE, business_now


def stamp_user_message(message: HumanMessage) -> HumanMessage:
    if "lma_context" in message.additional_kwargs:
        return message
    now = business_now()
    return message.model_copy(update={
        "additional_kwargs": {
            **message.additional_kwargs,
            "lma_context": {
                "sent_at": now.isoformat(timespec="seconds"),
                "timezone": BUSINESS_TIMEZONE,
            },
        },
    })


def model_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    projected = []
    for message in messages:
        context = message.additional_kwargs.get("lma_context")
        if not isinstance(message, HumanMessage) or context is None:
            projected.append(message)
            continue
        # 每条历史消息使用自身不可变的快照；不改 system prompt 或 checkpoint 正文。
        metadata = (
            "<lma_message_context>\n"
            f"sent_at: {context['sent_at']}\n"
            f"timezone: {context['timezone']}\n"
            "</lma_message_context>"
        )
        content = message.content
        if isinstance(content, str):
            content = f"{metadata}\n\n{content}"
        else:
            content = [{"type": "text", "text": metadata}, *content]
        kwargs = {
            key: value for key, value in message.additional_kwargs.items()
            if key != "lma_context"
        }
        projected.append(message.model_copy(update={
            "content": content,
            "additional_kwargs": kwargs,
        }))
    return projected
