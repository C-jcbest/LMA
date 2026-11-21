"""巡检原型：按范围巡检，先推出全部测点，再逐站合并初筛和视觉初判。"""

import unittest
from unittest.mock import AsyncMock, patch

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.beidou.schemas import Station
from app.inspection.lab import ROW_COMPONENT, SUMMARY_COMPONENT, build_lab_graph
from app.inspection.vision import VisionVerdict
from test_inspection_screening import NOW, daily, hourly


def station(uuid, name, group="g1", group_name="一号坡", station_type=3):
    return Station(
        StationUUID=uuid, StationName=name, StationType=station_type,
        StationGroupUUID=group, StationGroupName=group_name,
        StationN0="100", StationE0="200", StationU0="300",
    )


class LabPlatform:
    """长期窗口（带采样时刻）返回每日序列，近期窗口返回小时序列。"""

    def __init__(self, stations, daily_series):
        self.stations = stations
        self.daily_series = daily_series

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def get_stations(self):
        return self.stations

    async def get_daily_data(self, station_uuid, begin_time, end_time, sample_times=None):
        return self.daily_series[station_uuid] if sample_times else hourly()


STATIONS = [
    station("a", "台阶点"),
    station("b", "平稳点"),
    station("base", "基准站", station_type=1),
    station("c", "别组点", group="g2", group_name="二号坡"),
]
SERIES = {
    "a": daily(lambda i: 0 if i < 50 else 30, noise_mm=0.5),
    "b": daily(lambda i: 0, noise_mm=0.5),
    "c": daily(lambda i: 0, noise_mm=0.5),
}


async def run_lab(scope, *, vision=True):
    graph = build_lab_graph(lambda: LabPlatform(STATIONS, SERIES), InMemorySaver())
    config = {"configurable": {"thread_id": "lab-test"}}
    verdict = VisionVerdict(shape="台阶", summary="中段出现一次台阶后保持", data_quality="正常", confidence="中")
    events = []
    with patch("app.inspection.runner.business_now", return_value=NOW), \
            patch("app.inspection.lab.vision_configured", return_value=vision), \
            patch("app.inspection.lab.render_displacement_chart", return_value=b"png"), \
            patch("app.inspection.lab.judge_chart", AsyncMock(return_value=verdict)) as judge:
        async for event in graph.astream(
            {"messages": [HumanMessage(content="巡检")], "scope": scope}, config, stream_mode="custom",
        ):
            events.append(event)
        state = (await graph.aget_state(config)).values
    return events, state, judge


def latest_props(state, name):
    return {item["id"]: item["props"] for item in state["ui"] if item["name"] == name}


class InspectionLabTests(unittest.IsolatedAsyncioTestCase):
    async def test_group_scope_streams_pending_rows_then_screening_and_vision(self):
        events, state, judge = await run_lab({"kind": "group", "group_uuid": "g1"})

        first_screened = next(index for index, event in enumerate(events) if event["props"].get("status") == "screened")
        pending = [event for event in events[:first_screened] if event["name"] == ROW_COMPONENT]
        self.assertEqual({event["props"]["station_name"] for event in pending}, {"台阶点", "平稳点"})
        self.assertTrue(all(event["metadata"]["message_id"] for event in events))

        rows = {props["station_name"]: props for props in latest_props(state, ROW_COMPONENT).values()}
        self.assertEqual(rows["台阶点"]["screening"], "建议调查")
        self.assertTrue(rows["台阶点"]["triggers"])
        self.assertEqual(rows["台阶点"]["vision"]["summary"], "中段出现一次台阶后保持")
        self.assertTrue(rows["台阶点"]["vision"]["image"].startswith("data:image/png;base64,"))
        self.assertEqual(rows["平稳点"]["vision"], {"status": "skipped"})
        judge.assert_awaited_once()

        summary = next(iter(latest_props(state, SUMMARY_COMPONENT).values()))
        self.assertEqual((summary["label"], summary["total"], summary["attention"], summary["status"]),
                         ("一号坡 分组", 2, 1, "done"))
        self.assertIn("1 个建议调查", state["messages"][-1].content)

    async def test_without_vision_model_attention_rows_say_unavailable(self):
        _, state, judge = await run_lab({"kind": "station", "station_uuid": "a"}, vision=False)

        rows = list(latest_props(state, ROW_COMPONENT).values())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["vision"], {"status": "unavailable"})
        judge.assert_not_awaited()
        summary = next(iter(latest_props(state, SUMMARY_COMPONENT).values()))
        self.assertFalse(summary["common_mode_checked"])


if __name__ == "__main__":
    unittest.main()
