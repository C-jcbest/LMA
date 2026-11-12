"""不取监测数据的辅助工具：复杂调查的计划，以及测点以往的调查结论。"""

import json
from typing import Annotated, Literal

from langchain.tools import tool
from pydantic import BaseModel, ConfigDict, Field

from app.agent.tool_protocol import tool_result
from app.monitoring_data import monitoring

PLAN_TOOL_NAME = "update_plan"


class PlanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=80, description="一个调查步骤，业务语言，例如“核对 K3 近 90 天趋势”")
    status: Literal["pending", "in_progress", "completed"]


@tool(PLAN_TOOL_NAME, response_format="content_and_artifact")
async def update_plan(items: Annotated[list[PlanItem], Field(min_length=1, max_length=12)]):
    """多测点或多步骤的调查可以先列计划，并在推进时更新状态；计划会展示给用户。简单问答不需要。

    每次提交完整列表；同一时间最多一个步骤为 in_progress。计划是调查进度，不是监测结论。
    """
    return tool_result({"plan_items": len(items)}, kind="plan", display={"items": [item.model_dump() for item in items]})


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
