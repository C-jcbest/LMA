"""区分助手内部纠错与业务失败；旧错误只在读取时分类，不改写原始记录。"""
from datetime import datetime, timedelta

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage

from app.agent.tool_protocol import ToolInputError
from app.business_time import TIME_FORMAT


FEEDBACK_CATEGORY = "input_validation"


def is_tool_feedback(message) -> bool:
    if not isinstance(message, ToolMessage) or message.status != "error":
        return False
    if message.additional_kwargs.get("lma_tool_feedback") == FEEDBACK_CATEGORY:
        return True
    return _is_legacy_numerical_validation(message)


def _is_legacy_numerical_validation(message: ToolMessage) -> bool:
    """旧版唯一数值跨度校验分支：精确生成文案、失败产物及非法原窗必须同时匹配。"""
    artifact = message.artifact
    if message.name != "analyze_gnss_numerically" or not isinstance(artifact, dict):
        return False
    if artifact.get("kind") != "acquisition_failure" or artifact.get("status") != "error":
        return False
    error = artifact.get("error", {})
    data = artifact.get("data", {})
    if error.get("code") != "unavailable" or error.get("category") != "business":
        return False
    for sampling, days in (("daily", 365), ("hourly", 62)):
        original_feedback = (
            "工具参数不符合要求，请修正后重新调用。"
            f"Value error, {sampling}数值回查单次不超过{days}天，请分窗或选择每日采样"
        )
        if (message.content != original_feedback
                or error.get("message") != original_feedback
                or data.get("message") != original_feedback):
            continue
        try:
            start = datetime.strptime(data["begin_time"], TIME_FORMAT)
            end = datetime.strptime(data["end_time"], TIME_FORMAT)
        except (ValueError, TypeError, KeyError):
            return False
        return end - start > timedelta(days=days)
    return False


def is_feedback_record(record: dict) -> bool:
    metadata = record.get("message") or {}
    return is_tool_feedback(ToolMessage(
        content=metadata.get("content", ""),
        name=metadata.get("name"),
        status=metadata.get("status", "success"),
        tool_call_id=record.get("tool_call_id", ""),
        artifact=record.get("snapshot"),
        additional_kwargs=metadata.get("additional_kwargs", {}),
    ))


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
