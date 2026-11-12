"""区分助手内部纠错与业务失败：参数纠错只回给模型修正，不作为取数依据。"""
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage

from app.agent.tool_protocol import ToolInputError


FEEDBACK_CATEGORY = "input_validation"


def is_tool_feedback(message) -> bool:
    return (
        isinstance(message, ToolMessage)
        and message.status == "error"
        and message.additional_kwargs.get("lma_tool_feedback") == FEEDBACK_CATEGORY
    )


def _feedback_message(request, error):
    return ToolMessage(
        content=error.content,
        status="error",
        name=request.tool_call["name"],
        tool_call_id=request.tool_call["id"],
        additional_kwargs={"lma_tool_feedback": FEEDBACK_CATEGORY},
    )


class ToolFeedbackMiddleware(AgentMiddleware):
    """官方工具包装边界保留错误配对和模型反馈，不生成取数证据。"""

    def wrap_tool_call(self, request, handler):
        try:
            return handler(request)
        except ToolInputError as error:
            return _feedback_message(request, error)

    async def awrap_tool_call(self, request, handler):
        try:
            return await handler(request)
        except ToolInputError as error:
            return _feedback_message(request, error)
