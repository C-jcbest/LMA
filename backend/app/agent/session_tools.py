"""不取监测数据的辅助工具：测点以往的调查结论、最近一次巡检的全组概况。"""

import json
from typing import Annotated

from langchain.tools import tool
from pydantic import Field

from app.monitoring_data import monitoring

STATION_HISTORY_TOOL_NAME = "get_station_history"
LATEST_INSPECTION_TOOL_NAME = "get_latest_inspection"
_INSPECTION_REASON_LIMIT = 3


def station_history_tool(storage):
    @tool(STATION_HISTORY_TOOL_NAME)
    async def get_station_history(
        station_name_or_uuid: Annotated[str, Field(min_length=1, max_length=200, description="监测点名称或 UUID")],
    ) -> str:
        """查询测点以往的调查结论和最近一次巡检初筛结果，用于延续之前的调查或对比前后变化。

        以往结论是当时的判断，不代表现状；当前状况仍需重新取数。
        """
        async with monitoring() as data:
            station = await data.resolve_station(station_name_or_uuid)
        history = await storage.station_history(station.station_uuid)
        return json.dumps({
            "station": {"station_uuid": station.station_uuid, "station_name": station.station_name},
            **history,
            "note": "以往结论和巡检初筛反映当时的数据，不代表当前状况",
        }, ensure_ascii=False, default=str)

    return get_station_history


def latest_inspection_tool(storage):
    @tool(LATEST_INSPECTION_TOOL_NAME)
    async def get_latest_inspection(
        group_name: Annotated[str | None, Field(default=None, max_length=200, description="只看某个分组时传分组名称（包含匹配）")] = None,
    ) -> str:
        """读取最近一次巡检的全部测点概况：每个测点的当前判断（较新的调查结论优先，调查后巡检又发现新变化时回到初筛）、
        初筛原因、累计水平偏移和速率走势。

        回答“今天哪些点需要注意”“这个组有没有要看的”这类分组或全局问题时先用它，再只对值得深挖的测点取数，
        不必逐个测点查询。巡检反映巡检当时的数据，深挖时以重新取得的数据为准。
        """
        latest = await storage.latest_inspection()
        inspection = latest["inspection"]
        if inspection is None:
            return json.dumps({"inspection": None, "note": "还没有成功完成的巡检；需要时逐个测点取数"}, ensure_ascii=False)
        rows = [row for row in latest["stations"] if not group_name or group_name in row["group_name"]]
        return json.dumps({
            "inspected_at": inspection["finished_at"],
            "running": latest["running"] is not None,
            "station_count": len(rows),
            "stations": [_inspection_row(row) for row in rows],
            "note": "按当前判断从需要处理到平稳排序；初筛只是调查优先级，不是结论或预警",
        }, ensure_ascii=False, default=str)

    return get_latest_inspection


def _inspection_row(row: dict) -> dict:
    metrics = row.get("metrics") or {}
    cumulative = metrics.get("cumulative_offset_mm") or {}
    rates = metrics.get("rate_sequence") or {}
    current = row.get("current") or {}
    return {
        "station_uuid": row["station_uuid"],
        "station_name": row["station_name"],
        "group_name": row["group_name"],
        "current": {key: current.get(key) for key in ("status", "source", "at", "reason", "changed_since_investigation")},
        "screening": row["screening"],
        "screening_reasons": (row.get("reasons") or [])[:_INSPECTION_REASON_LIMIT],
        "cumulative_horizontal_mm": cumulative.get("h"),
        "rate_pattern": {window: (rates.get(window) or {}).get("pattern") for window in ("recent", "long")},
        "recent_completeness": metrics.get("recent_completeness"),
    }
