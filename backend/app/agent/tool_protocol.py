"""LangChain 工具内容、展示数据与受控业务异常。artifact 不属于保密通道。"""
import json
from langchain_core.tools import ToolException


class ToolFailure(ToolException):
    """可公开的业务失败；只允许放入已审定的事实和展示数据。"""
    def __init__(self, message: str, *, category: str = "business", artifact: dict | None = None, facts: dict | None = None):
        super().__init__(message)
        self.content = json.dumps({**facts, "message": message}, ensure_ascii=False) if facts is not None else message
        self.category = category
        self.artifact = {**(artifact or {}), "data": {**(artifact or {}).get("data", {}), "message": message}, "error": {"category": category}}


def tool_result(facts: dict, *, artifact: dict | None = None, display: dict | None = None):
    """content 保留模型证据，artifact.data 为界面数据；诊断只写日志。"""
    return json.dumps(facts, ensure_ascii=False), {**(artifact or {}), "data": facts if display is None else display}


VALIDATION_MESSAGE = "工具参数不符合要求，请检查时间格式、时间顺序、取样方式或筛选范围后重新查询。"
