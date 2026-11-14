"""不取监测数据的辅助工具：测点以往的调查结论。"""

import json
from typing import Annotated

from langchain.tools import tool
from pydantic import Field

from app.monitoring_data import monitoring

def station_history_tool(storage):
    @tool
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
