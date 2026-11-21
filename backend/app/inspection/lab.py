"""巡检原型：点击巡检后以生成式 UI 流式推送结果。

一次巡检是一条 LangGraph 线程。announce 节点先写入一条助手消息，inspect 节点把汇总卡片和每个测点的行
用 push_ui_message 挂到这条消息上：先推出全部待巡检测点，初筛完成一站就合并更新一站，
建议调查的测点再交给视觉模型初判。组件状态保存在图状态的 ui 字段，刷新或重连后可恢复。

原型不写入正式巡检表，今日页和测点列表仍以正式巡检为准。
"""

import asyncio
import base64
import logging
import time
from collections import defaultdict
from typing import Annotated, Callable, Literal, Sequence, TypedDict
from uuid import uuid4

from langchain_core.messages import AIMessage, AnyMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.ui import AnyUIMessage, push_ui_message, ui_message_reducer

from app.beidou.client import BeidouClient
from app.beidou.schemas import Station
from app.inspection.runner import screen_with_points
from app.inspection.screening import ScreeningResult, apply_group_checks
from app.inspection.vision import judge_chart, render_displacement_chart, vision_configured

logger = logging.getLogger(__name__)

DISPLACEMENT_STATION_TYPES = {2, 3}
_UPSTREAM_CONCURRENCY = 4
_VISION_CONCURRENCY = 2
_AXIS_LABELS = {"n": "北向", "e": "东向", "u": "垂向"}

SUMMARY_COMPONENT = "inspection_summary"
ROW_COMPONENT = "station_row"


class LabScope(TypedDict, total=False):
    kind: Literal["all", "group", "station"]
    group_uuid: str
    station_uuid: str


class LabState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    ui: Annotated[Sequence[AnyUIMessage], ui_message_reducer]
    scope: LabScope


def stations_in_scope(stations: Sequence[Station], scope: LabScope) -> list[Station]:
    candidates = [station for station in stations if station.station_type in DISPLACEMENT_STATION_TYPES]
    if scope.get("kind") == "group":
        candidates = [station for station in candidates if station.group_uuid == scope.get("group_uuid")]
    elif scope.get("kind") == "station":
        candidates = [station for station in candidates if station.station_uuid == scope.get("station_uuid")]
    return sorted(candidates, key=lambda station: (station.group_name, station.station_name))


def scope_label(scope: LabScope, stations: Sequence[Station]) -> str:
    if scope.get("kind") == "group":
        return f"{stations[0].group_name} 分组" if stations else "所选分组"
    if scope.get("kind") == "station":
        return stations[0].station_name if stations else "所选测点"
    return "全部测点"


def _largest_change(result: ScreeningResult) -> dict | None:
    """90 天窗口变化最大的方向；界面标明窗口，避免与测点页的累计值混淆。"""
    changes = result.metrics.get("net_change_mm") or {}
    candidates = [(axis, value) for axis, value in changes.items() if isinstance(value, (int, float))]
    if not candidates:
        return None
    axis, value = max(candidates, key=lambda item: abs(item[1]))
    return {"axis": _AXIS_LABELS.get(axis, axis), "millimeters": value, "window_days": 90}


def _row_findings(result: ScreeningResult) -> dict:
    triggers = [finding for finding in result.findings if finding.role == "trigger"]
    quality = [finding for finding in result.findings if finding.role == "quality"]
    if not result.findings:
        return {"triggers": [], "quality": [{"text": reason} for reason in result.reasons]}
    return {
        "triggers": [
            {"kind": finding.kind, "axis": _AXIS_LABELS.get(finding.axis or "", None), "window": finding.window,
             "value_mm": finding.value_mm, "days": finding.days, "text": finding.text}
            for finding in triggers
        ],
        "quality": [{"kind": finding.kind, "text": finding.text} for finding in quality],
    }


def build_lab_graph(platform_client_factory: Callable[[], BeidouClient], checkpointer):
    async def announce(state: LabState) -> dict:
        return {"messages": [AIMessage(id=str(uuid4()), content="正在巡检…")]}

    async def inspect(state: LabState) -> dict:
        message = state["messages"][-1]
        scope = state.get("scope") or {"kind": "all"}
        summary_id = f"summary-{message.id}"
        started = time.monotonic()

        def push_summary(**props) -> None:
            push_ui_message(SUMMARY_COMPONENT, props, id=summary_id, message=message, merge=True)

        def push_row(station: Station, **props) -> None:
            push_ui_message(ROW_COMPONENT, props, id=f"row-{message.id}-{station.station_uuid}", message=message, merge=True)

        try:
            async with platform_client_factory() as client:
                stations = stations_in_scope(await client.get_stations(), scope)
                label = scope_label(scope, stations)
                has_vision = vision_configured()
                push_summary(label=label, total=len(stations), screened=0, attention=0, judged=0,
                             status="running", vision_enabled=has_vision)
                for station in stations:
                    push_row(station, station_uuid=station.station_uuid, station_name=station.station_name,
                             group_name=station.group_name, status="pending")

                counts = {"screened": 0, "attention": 0, "judged": 0}
                results: dict[str, ScreeningResult] = {}
                upstream = asyncio.Semaphore(_UPSTREAM_CONCURRENCY)
                vision_slots = asyncio.Semaphore(_VISION_CONCURRENCY)

                async def handle(station: Station) -> None:
                    result, long_points = await screen_with_points(client, station, upstream)
                    results[station.station_uuid] = result
                    needs_look = result.screening == "建议调查"
                    counts["screened"] += 1
                    counts["attention"] += int(needs_look)
                    vision_status = "skipped"
                    if needs_look:
                        vision_status = "running" if has_vision and long_points else "unavailable"
                    push_row(station, status="screened", screening=result.screening, change=_largest_change(result),
                             trend=result.trend, vision={"status": vision_status}, **_row_findings(result))
                    push_summary(screened=counts["screened"], attention=counts["attention"])
                    if vision_status != "running":
                        return
                    async with vision_slots:
                        try:
                            png = await asyncio.to_thread(render_displacement_chart, long_points, station.station_name)
                            verdict = await judge_chart(png, station.station_name, result.reasons[:8])
                            vision = {
                                "status": "done", **verdict.model_dump(),
                                "image": f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}",
                            }
                        except Exception:
                            logger.warning("inspection lab vision failed: %s", station.station_uuid, exc_info=True)
                            vision = {"status": "error"}
                    counts["judged"] += 1
                    push_row(station, vision=vision)
                    push_summary(judged=counts["judged"])

                await asyncio.gather(*(handle(station) for station in stations))
        except Exception:
            logger.exception("inspection lab failed")
            push_summary(status="error", elapsed_seconds=round(time.monotonic() - started))
            return {"messages": [AIMessage(id=message.id, content="巡检未完成：监测平台暂不可用。")]}

        if scope.get("kind") != "station":
            by_group: dict[str, list[tuple[Station, ScreeningResult]]] = defaultdict(list)
            for station in stations:
                by_group[station.group_uuid].append((station, results[station.station_uuid]))
            for members in by_group.values():
                before = {station.station_uuid: len(result.findings) for station, result in members}
                apply_group_checks([result for _, result in members])
                for station, result in members:
                    if len(result.findings) != before[station.station_uuid]:
                        push_row(station, **_row_findings(result))

        elapsed = round(time.monotonic() - started)
        push_summary(status="done", elapsed_seconds=elapsed, common_mode_checked=scope.get("kind") != "station")
        text = f"巡检完成：{label}，{len(stations)} 个测点，{counts['attention']} 个建议调查。"
        return {"messages": [AIMessage(id=message.id, content=text)]}

    graph = StateGraph(LabState)
    graph.add_node("announce", announce)
    graph.add_node("inspect", inspect)
    graph.add_edge(START, "announce")
    graph.add_edge("announce", "inspect")
    graph.add_edge("inspect", END)
    return graph.compile(checkpointer=checkpointer)
