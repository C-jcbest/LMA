"""LangChain 工具内容、展示数据与受控业务异常。artifact 不属于保密通道。"""
import json
from typing import Any
from langchain_core.tools import ToolException


class ToolFailure(ToolException):
    """可公开的业务失败；只允许放入已审定的事实和展示数据。"""
    def __init__(
        self,
        message: str,
        *,
        kind: str = "generic",
        category: str = "business",
        artifact: dict | None = None,
        facts: dict | None = None,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.content = json.dumps({**facts, "message": message}, ensure_ascii=False) if facts is not None else message
        self.category = category
        base_artifact = dict(artifact or {})
        base_data = dict(base_artifact.get("data", {}))
        base_data["message"] = message
        error_info = {
            "code": category,
            "category": category,
            "message": message,
            "retryable": retryable,
        }
        self.artifact = {
            "version": 1,
            "kind": kind,
            "status": "error",
            **base_artifact,
            "data": base_data,
            "error": error_info,
        }


def tool_result(
    facts: dict,
    *,
    kind: str = "generic",
    status: str = "success",
    artifact: dict | None = None,
    display: dict | None = None,
    sources: list[dict[str, Any]] | None = None,
    limitations: list[str] | None = None,
    observed_at: str | None = None,
):
    """content 保留模型证据，artifact 符合标准 ToolArtifactEnvelope 规范。"""
    base_artifact = dict(artifact or {})
    envelope: dict[str, Any] = {
        "version": 1,
        "kind": kind,
        "status": status,
        **base_artifact,
        "data": facts if display is None else display,
    }
    if sources is not None:
        envelope["sources"] = sources
    if limitations is not None:
        envelope["limitations"] = limitations
    if observed_at is not None:
        envelope["observedAt"] = observed_at
    return json.dumps(facts, ensure_ascii=False), envelope


VALIDATION_MESSAGE = "工具参数不符合要求，请检查时间格式、时间顺序、取样方式或筛选范围后重新查询。"
