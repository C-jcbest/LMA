"""LangChain 工具内容、展示数据与受控业务异常。artifact 不属于保密通道。"""
import json
from typing import Any
from langchain_core.messages import ToolMessage
from langchain_core.tools import ToolException
from app.agent.artifacts import validate_artifact_data, validate_artifact_envelope


class ToolFailure(ToolException):
    """不含部分证据的可公开业务失败，由 ToolErrorMiddleware 转为错误消息。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.content = message


def tool_error_result(
    message: str,
    *,
    tool_call_id: str,
    tool_name: str,
    kind: str,
    category: str = "business",
    data: dict,
    facts: dict | None = None,
    sources: list[dict[str, Any]] | None = None,
    limitations: list[str] | None = None,
    observed_at: str | None = None,
) -> tuple[ToolMessage, dict[str, Any]]:
    """返回保留部分证据的官方错误 ToolMessage；仅用于工具已有可展示结果时。"""
    content = (
        json.dumps({**facts, "message": message}, ensure_ascii=False)
        if facts is not None
        else message
    )
    envelope_data: dict[str, Any] = {
        "version": 1,
        "kind": kind,
        "status": "error",
        "data": validate_artifact_data(kind, data),
        "error": {
            "code": category,
            "category": category,
            "message": message,
            "retryable": False,
        },
    }
    if sources is not None:
        envelope_data["sources"] = sources
    if limitations is not None:
        envelope_data["limitations"] = limitations
    if observed_at is not None:
        envelope_data["observedAt"] = observed_at
    envelope = validate_artifact_envelope(envelope_data)
    return ToolMessage(
        content=content,
        artifact=envelope,
        tool_call_id=tool_call_id,
        name=tool_name,
        status="error",
    ), envelope


def tool_result(
    facts: dict,
    *,
    kind: str = "generic",
    status: str = "success",
    display: dict | None = None,
    sources: list[dict[str, Any]] | None = None,
    limitations: list[str] | None = None,
    observed_at: str | None = None,
):
    """content 保留模型证据，artifact 符合标准 ToolArtifactEnvelope 规范。"""
    envelope: dict[str, Any] = {
        "version": 1,
        "kind": kind,
        "status": status,
        "data": validate_artifact_data(kind, facts if display is None else display),
    }
    if sources is not None:
        envelope["sources"] = sources
    if limitations is not None:
        envelope["limitations"] = limitations
    if observed_at is not None:
        envelope["observedAt"] = observed_at
    return json.dumps(facts, ensure_ascii=False), validate_artifact_envelope(envelope)


VALIDATION_MESSAGE = "工具参数不符合要求，请检查时间格式、时间顺序、取样方式或筛选范围后重新查询。"
