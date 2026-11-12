"""结论登记：正文之外的一份精简留档，供测点记录和后续周报、月报使用。

只登记每个测点的调查状态、一句话原因和目标窗口；依据由服务端从本会话自动关联。
校验只覆盖能确定判断的条件：测点确实取过数、状态和窗口与已取得的数据相符。
措辞和推断是否恰当不在这里判断。
"""

from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from langchain.tools import ToolRuntime, tool
from pydantic import BaseModel, ConfigDict, Field

from app.agent.station_evidence import evidence_by_station
from app.agent.tool_protocol import ToolInputError, tool_result
from app.business_time import TIME_FORMAT

CONCLUSIONS_TOOL_NAME = "record_conclusions"
# 有数据支撑的状态必须有成功的位移依据，且结论窗口落在已取得数据的范围内。
_DATA_BACKED_STATUSES = {"未见明显变化", "持续关注", "需人工复核"}
# 模型常把窗口写成整点或整天，与实际查询边界差几分钟到一小时属于同一窗口。
_WINDOW_TOLERANCE = timedelta(hours=1)


class ConclusionStation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    station_uuid: UUID
    status: Literal["未见明显变化", "持续关注", "需人工复核", "数据不足", "暂无法分析"] = Field(
        description=(
            "未见明显变化：现有数据未显示值得关注的变化；持续关注：存在持续或同向变化，尚无突变或加速迹象；"
            "需人工复核：突变、疑似加速或证据相互矛盾；数据不足：取得了数据但覆盖或质量不足以判断；"
            "暂无法分析：未能取得可用数据"
        ),
    )
    reason: str = Field(min_length=1, max_length=200, description="得到该状态的一句话原因")
    begin_time: datetime = Field(description="结论适用的时间窗起点")
    end_time: datetime


def _business_time(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    return value


def _covered(begin: datetime, end: datetime, windows: list[tuple[str, str]]) -> bool:
    if not windows:
        return False
    first = min(datetime.strptime(window[0], TIME_FORMAT) for window in windows)
    last = max(datetime.strptime(window[1], TIME_FORMAT) for window in windows)
    return begin >= first - _WINDOW_TOLERANCE and end <= last + _WINDOW_TOLERANCE


@tool(CONCLUSIONS_TOOL_NAME, response_format="content_and_artifact")
async def record_conclusions(
    stations: Annotated[list[ConclusionStation], Field(min_length=1, max_length=100)],
    runtime: ToolRuntime,
):
    """为本次调查涉及的测点登记调查状态，用于测点记录和周报。和正文同时提交即可，不替代正文回答。

    每个测点给出状态、一句话原因和结论适用的时间窗；依据由系统自动关联。只问概念或简单查数时不需要登记。
    """
    evidence = evidence_by_station(runtime.state["messages"])
    recorded = []
    seen = set()
    for station in stations:
        identifier = str(station.station_uuid)
        if identifier in seen:
            raise ToolInputError("同一测点只登记一次")
        seen.add(identifier)
        found = evidence.get(identifier)
        if found is None:
            raise ToolInputError(f"测点 {identifier} 在本会话没有任何依据，不能登记结论；请先取数或删去该测点")
        begin = _business_time(station.begin_time)
        end = _business_time(station.end_time)
        if begin >= end:
            raise ToolInputError("结论时间窗必须正向")
        if station.status in _DATA_BACKED_STATUSES and not _covered(begin, end, found.displacement_windows):
            raise ToolInputError(
                f"{found.station_name} 的状态“{station.status}”需要覆盖结论窗口的位移数据；"
                "请按实际取得数据的窗口登记，或补充取数，数据不够时登记为数据不足"
            )
        recorded.append({
            "station_uuid": identifier,
            "station_name": found.station_name,
            "status": station.status,
            "reason": station.reason,
            "begin_time": begin.strftime(TIME_FORMAT),
            "end_time": end.strftime(TIME_FORMAT),
            "evidence": found.evidence_ids,
        })
    return tool_result({"recorded": len(recorded)}, kind="conclusions", display={"stations": recorded})
