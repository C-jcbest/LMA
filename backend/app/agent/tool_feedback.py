"""区分工具结果的三种去向：参数纠错只回给模型修正；取数失败保留为可登记“暂无法分析”的依据；其余原样返回。"""
from uuid import UUID

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage

from app.agent.artifacts import validate_artifact_envelope
from app.agent.station_evidence import evidence_by_station
from app.agent.tool_protocol import FEEDBACK_CATEGORY, ToolInputError
from app.business_time import business_now


def _feedback_message(request, error):
    return ToolMessage(
        content=error.content,
        status="error",
        name=request.tool_call["name"],
        tool_call_id=request.tool_call["id"],
        additional_kwargs={"lma_tool_feedback": FEEDBACK_CATEGORY},
    )


def _known_stations(messages) -> dict[str, str]:
    """本会话已确认身份的测点：取得过依据的测点和用户正在查看的测点。"""
    known = {identifier: item.station_name for identifier, item in evidence_by_station(messages).items()}
    for message in messages:
        if isinstance(message, HumanMessage):
            focus = message.additional_kwargs.get("lma_context", {}).get("focus_identity")
            if focus:
                known[focus["station_uuid"]] = focus["station_name"]
    return known


def _failure_artifact(request, result: ToolMessage) -> dict | None:
    """针对某个测点的取数失败也是依据：结论可以据此如实登记“暂无法分析”。"""
    args = request.tool_call["args"]
    requested = args.get("station_name_or_uuid")
    if not requested:
        return None
    known = _known_stations(request.state.get("messages", []))
    identifier = None
    try:
        identifier = str(UUID(requested))
    except ValueError:
        candidates = [identifier for identifier, name in known.items() if name == requested]
        if len(candidates) == 1:
            identifier = candidates[0]
    return validate_artifact_envelope({
        "version": 1, "kind": "acquisition_failure", "status": "error",
        "data": {"station_uuid": identifier, "station_name": known.get(identifier, requested),
                 "begin_time": args.get("begin_time") or args.get("start_date"),
                 "end_time": args.get("end_time") or args.get("end_date"),
                 "message": result.text, "requested_station": requested},
        "error": {"code": "unavailable", "category": "business", "message": result.text, "retryable": False},
        "observedAt": business_now().isoformat(),
    })


def _with_failure_artifact(request, result):
    if not isinstance(result, ToolMessage) or result.status != "error" or result.artifact is not None:
        return result
    artifact = _failure_artifact(request, result)
    if artifact is None:
        return result
    return result.model_copy(update={"artifact": artifact})


class ToolFeedbackMiddleware(AgentMiddleware):
    """官方工具包装边界：参数纠错不生成依据，取数失败附带可展示的失败依据。"""

    def wrap_tool_call(self, request, handler):
        try:
            return _with_failure_artifact(request, handler(request))
        except ToolInputError as error:
            return _feedback_message(request, error)

    async def awrap_tool_call(self, request, handler):
        try:
            return _with_failure_artifact(request, await handler(request))
        except ToolInputError as error:
            return _feedback_message(request, error)
