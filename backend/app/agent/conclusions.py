"""结论登记：正文之外的一份精简留档，供测点记录和后续周报、月报使用。

只登记每个测点的调查状态、一句话原因和目标窗口；依据由服务端从本会话自动关联。
校验只覆盖能确定判断的条件：测点确实取过数、状态和窗口与已取得的数据相符。
措辞和推断是否恰当不在这里判断。
"""

import math
from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import ToolMessage
from pydantic import BaseModel, ConfigDict, Field

from app.agent.message_context import is_evidence
from app.agent.station_evidence import evidence_by_station
from app.agent.tool_protocol import ToolInputError, tool_result
from app.business_time import TIME_FORMAT
from app.observations import finite_number

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
    next_step: str | None = Field(
        default=None, max_length=80,
        description="建议的现场或业务动作，一句话，例如“现场核查观测墩与天线，保持小时级跟踪”；数据工作不写在这里",
    )
    begin_time: datetime = Field(description="结论适用的时间窗起点")
    end_time: datetime


class FollowUp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(
        min_length=1, max_length=60,
        description="用户口吻的一句追问，例如“对比同组 10-20 之后是否同步”；来自本次调查没覆盖到的部分",
    )
    station_uuid: UUID | None = Field(default=None, description="追问针对的测点")
    begin_time: datetime | None = Field(default=None, description="追问针对的时间段起点，与 end_time 成对")
    end_time: datetime | None = None


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


def _displacement_windows(messages, station_uuid: str) -> list[dict]:
    """本会话里该测点成功取得的位移窗口（展示数据），包括测点概览里的两个窗口。"""
    windows = []
    for message in messages:
        if not isinstance(message, ToolMessage) or not is_evidence(message):
            continue
        artifact = message.artifact
        if artifact.get("status") == "error":
            continue
        data = artifact.get("data", {})
        if data.get("station_uuid") != station_uuid:
            continue
        if artifact.get("kind") == "gnss_series":
            windows.append(data)
        elif artifact.get("kind") == "station_overview":
            windows.extend(data.get("windows", []))
    return [window for window in windows if window.get("points")]


def _horizontal_mm(point: dict, base: dict) -> float | None:
    north = finite_number(point.get("n"))
    east = finite_number(point.get("e"))
    base_north = finite_number(base.get("n"))
    base_east = finite_number(base.get("e"))
    if None in (north, east, base_north, base_east):
        return None
    return round(math.hypot(north - base_north, east - base_east) * 1000, 1)


def _key_figures(messages, station_uuid: str, begin: datetime, end: datetime) -> dict | None:
    """判断头的关键数由服务端从依据计算，不靠模型抄数字：结论窗口内的水平变化、累计水平偏移和数据完整度。

    取与结论窗口最接近的那次位移查询；水平变化为窗口首末两点的水平位移矢量长度。
    """
    windows = _displacement_windows(messages, station_uuid)
    if not windows:
        return None

    def distance(window):
        window_begin = datetime.strptime(window["begin_time"], TIME_FORMAT)
        window_end = datetime.strptime(window["end_time"], TIME_FORMAT)
        return abs((window_begin - begin).total_seconds()) + abs((window_end - end).total_seconds())

    window = min(windows, key=distance)
    points = [point for point in window["points"]
              if finite_number(point.get("n")) is not None and finite_number(point.get("e")) is not None]
    if not points:
        return None
    reference = (window.get("reference") or {}).get("coordinates_m") or {}
    quality = window.get("quality") or {}
    expected = quality.get("expected")
    missing = quality.get("missing")
    completeness = None
    if isinstance(expected, int) and expected > 0 and isinstance(missing, int):
        completeness = round(1 - missing / expected, 2)
    return {
        "begin_time": window["begin_time"],
        "end_time": window["end_time"],
        "window_horizontal_change_mm": _horizontal_mm(points[-1], points[0]),
        "cumulative_horizontal_mm": _horizontal_mm(points[-1], reference),
        "completeness": completeness,
    }


def _follow_up_record(item: FollowUp) -> dict:
    record = {"question": item.question}
    if item.station_uuid is not None:
        record["station_uuid"] = str(item.station_uuid)
    if item.begin_time is not None and item.end_time is not None:
        record["begin_time"] = _business_time(item.begin_time).strftime(TIME_FORMAT)
        record["end_time"] = _business_time(item.end_time).strftime(TIME_FORMAT)
    return record


@tool(CONCLUSIONS_TOOL_NAME, response_format="content_and_artifact")
async def record_conclusions(
    stations: Annotated[list[ConclusionStation], Field(min_length=1, max_length=100)],
    runtime: ToolRuntime,
    follow_ups: Annotated[list[FollowUp], Field(max_length=3)] = [],
):
    """为本次调查涉及的测点登记调查状态，用于测点记录和周报。和正文同时提交即可，不替代正文回答。

    每个测点给出状态、一句话原因、结论适用的时间窗，以及可选的现场或业务下一步；依据由系统自动关联。
    follow_ups 列出 0–3 个本次没覆盖、用户可能想继续的问题，界面显示为一键继续的按钮；
    查询额度内能自己补的数据缺口直接补，不放进这里。只问概念或简单查数时不需要登记。
    """
    messages = runtime.state["messages"]
    evidence = evidence_by_station(messages)
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
            "next_step": station.next_step,
            "begin_time": begin.strftime(TIME_FORMAT),
            "end_time": end.strftime(TIME_FORMAT),
            "evidence": found.evidence_ids,
            "key_figures": _key_figures(messages, identifier, begin, end),
        })
    follow_up_records = [_follow_up_record(item) for item in follow_ups]
    return tool_result(
        {"recorded": len(recorded)}, kind="conclusions",
        display={"stations": recorded, "follow_ups": follow_up_records},
    )
