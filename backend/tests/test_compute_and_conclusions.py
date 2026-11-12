"""compute 只在本会话依据上计算、拒绝越界代码；结论登记只校验可确定的条件。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool

from app.agent import graph, summarization
from app.agent.compute import compute
from app.agent.conclusions import record_conclusions
from app.agent.message_context import evidence_id
from app.agent.tool_feedback import is_tool_feedback
from app.agent.tool_protocol import tool_result
from runtime_fixtures import ScriptedModel

STATION = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def series(station=STATION, name="测试点", begin="2026-10-01 00:00:00", end="2026-10-03 00:00:00", comparisons=None):
    points = [
        {"time": f"2026-10-0{day} {hour:02d}:00:00", "n": 100 + 0.001 * (day - 1) + 0.0001 * hour, "e": 200.0, "u": 300.0}
        for day in (1, 2, 3) for hour in (0, 12) if f"2026-10-0{day} {hour:02d}:00:00" <= end
    ]
    return {
        "station_uuid": station, "station_name": name, "begin_time": begin, "end_time": end,
        "timezone": "Asia/Shanghai", "total_points": len(points), "returned_points": len(points), "downsampled": False,
        "points": points, "summary": {"n": {"count": len(points)}, "e": {"count": len(points)}, "u": {"count": len(points)}, "gaps": []},
        "reference": {"coordinates_m": {"n": 100.0, "e": 200.0, "u": None}}, "comparisons": comparisons or {},
    }


@tool(response_format="content_and_artifact")
def displacement() -> tuple[str, dict]:
    """返回固定位移序列。"""
    return tool_result({"ok": True}, kind="gnss_series", display=series(comparisons={
        "station_names": {STATION: "测试点", OTHER: "对比点"}, "failures": {},
        "snapshots": {STATION: [{"time": "2026-10-01 00:00:00", "n": 100}], OTHER: [{"time": "2026-10-01 00:00:00", "n": 100}]},
    }))


@tool(response_format="content_and_artifact")
def weather() -> tuple[str, dict]:
    """返回固定天气。"""
    return tool_result({"ok": True}, kind="weather", display={
        "ok": True, "location": {"station_uuid": STATION, "station_name": "测试点", "latitude": 30, "longitude": 120},
        "query": {"timezone": "Asia/Shanghai", "history_start_date": "2026-10-01", "history_end_date": "2026-10-01", "forecast_days": 0, "hourly": True},
        "history": {"daily": {"time": ["2026-10-01"], "precipitation_sum": [3.0]},
                    "hourly": {"time": ["2026-10-01T00:00", "2026-10-01T01:00", "2026-10-01T02:00"], "precipitation": [0.5, None, 1.5]}},
    })


def call(identifier, name, args=None, text=""):
    return AIMessage(content=text, tool_calls=[{"id": identifier, "name": name, "args": args or {}}])


class AgentToolTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(agent_max_retries=0, agent_retry_initial_delay=0, agent_retry_max_delay=0,
            agent_model_run_limit=10, agent_tool_run_limit=40, llm_model="test", context_token_threshold=800000,
            context_model_context=1048576, context_keep_tokens=400000, context_summary_max_tokens=2000)
        for module in (graph, summarization):
            patcher = patch.object(module, "get_settings", return_value=settings)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def run_calls(self, *steps, tools=(displacement, weather, compute, record_conclusions)):
        model = ScriptedModel(script=[*steps, AIMessage(content="完成")])
        agent = graph.create_lma_agent(model, agent_tools=list(tools), summary_model=ScriptedModel(script=[]))
        result = await agent.ainvoke({"messages": [{"role": "user", "content": "调查"}]})
        return {message.tool_call_id: message for message in result["messages"] if isinstance(message, ToolMessage)}


class ComputeTests(AgentToolTestCase):
    async def test_computes_on_session_evidence_and_result_is_citable(self):
        source = evidence_id("d1")
        results = await self.run_calls(
            call("d1", "displacement"),
            call("c1", "compute", {
                "description": "每日北向末值变化", "inputs": [source],
                "code": "result = df['dn'].resample('D').last().diff().dropna()",
            }),
        )
        message = results["c1"]
        self.assertEqual(message.status, "success")
        self.assertEqual(json.loads(message.content)["result"]["values"], [1.0, -0.2])
        self.assertEqual(message.artifact["kind"], "computation")
        self.assertEqual(message.artifact["data"]["inputs"][0]["evidence_id"], source)
        self.assertIn("测试点 位移", message.artifact["data"]["inputs"][0]["description"])

    async def test_missing_reference_axis_is_unknown_not_zero(self):
        results = await self.run_calls(
            call("d1", "displacement"),
            call("c1", "compute", {"description": "垂向累计", "inputs": [evidence_id("d1")],
                                   "code": "result = {'du_all_missing': bool(df['du'].isna().all())}"}),
        )
        self.assertTrue(json.loads(results["c1"].content)["result"]["du_all_missing"])

    async def test_hourly_weather_keeps_missing_values_missing(self):
        results = await self.run_calls(
            call("w1", "weather"),
            call("c1", "compute", {"description": "统计降雨", "inputs": [evidence_id("w1")],
                                   "code": "hourly = data[list(data)[0]]['hourly']\nresult = {'sum': hourly['precipitation'].sum(), 'missing': int(hourly['precipitation'].isna().sum())}"}),
        )
        self.assertEqual(json.loads(results["c1"].content)["result"], {"sum": 2.0, "missing": 1})

    async def test_dates_formatting_and_provided_module_imports_work(self):
        # 真实模型评测中出现过：strftime 与 numpy 归约会隐式导入内部模块，日期结果曾无法序列化。
        results = await self.run_calls(
            call("d1", "displacement"),
            call("c1", "compute", {"description": "按天取北向最大值", "inputs": [evidence_id("d1")], "code": (
                "import numpy as np\n"
                "print('rows', len(df))\n"
                "daily = df.groupby(df.index.date)['dn'].max()\n"
                "result = {'first_day': df.index[0].date(), 'label': df.index[0].strftime('%m-%d %H:%M'),"
                " 'mean': float(np.mean(daily.values)), 'days': daily}"
            )}),
        )
        self.assertEqual(results["c1"].status, "success")
        value = json.loads(results["c1"].content)["result"]
        self.assertEqual((value["first_day"], value["label"]), ("2026-10-01", "10-01 00:00"))
        self.assertEqual(value["days"]["index"], ["2026-10-01", "2026-10-02", "2026-10-03"])
        # 中间打印只回给模型，不进入展示依据。
        self.assertEqual(json.loads(results["c1"].content)["printed"], "rows 5\n")
        self.assertNotIn("printed", results["c1"].artifact["data"])

    async def test_unsafe_or_wrong_input_is_returned_to_the_model_as_feedback(self):
        source = evidence_id("d1")
        cases = {
            "import": ("import os\nresult = 1", [source]),
            "submodule": ("import numpy.ctypeslib\nresult = 1", [source]),
            "from-banned": ("from numpy import ctypeslib\nresult = 1", [source]),
            "dunder": ("result = df.__class__", [source]),
            "file": ("result = pd.read_csv('x')", [source]),
            "no-result": ("value = 1", [source]),
            "unknown-input": ("result = 1", ["Eunknown"]),
            "runtime-error": ("result = 1 / 0", [source]),
        }
        for name, (code, inputs) in cases.items():
            with self.subTest(case=name):
                results = await self.run_calls(
                    call("d1", "displacement"),
                    call("c1", "compute", {"description": "测试", "code": code, "inputs": inputs}),
                )
                self.assertEqual(results["c1"].status, "error")
                self.assertTrue(is_tool_feedback(results["c1"]))


class ConclusionTests(AgentToolTestCase):
    def conclusion(self, status, station=STATION, begin="2026-10-01 00:00:00", end="2026-10-03 00:00:00"):
        return {"stations": [{"station_uuid": station, "status": status, "reason": "测试原因", "begin_time": begin, "end_time": end}]}

    async def test_data_backed_status_needs_displacement_covering_the_window(self):
        results = await self.run_calls(
            call("d1", "displacement"),
            call("r1", "record_conclusions", self.conclusion("持续关注"), text="正文"),
        )
        recorded = results["r1"].artifact["data"]["stations"][0]
        self.assertEqual(recorded["station_name"], "测试点")
        self.assertEqual(recorded["evidence"], [evidence_id("d1")])

        results = await self.run_calls(
            call("d1", "displacement"),
            call("r1", "record_conclusions", self.conclusion("未见明显变化", begin="2026-07-01 00:00:00")),
        )
        self.assertTrue(is_tool_feedback(results["r1"]))
        self.assertIn("数据不足", results["r1"].content)

    async def test_station_without_any_evidence_cannot_be_recorded(self):
        results = await self.run_calls(call("r1", "record_conclusions", self.conclusion("数据不足", station="33333333-3333-3333-3333-333333333333")))
        self.assertTrue(is_tool_feedback(results["r1"]))

    async def test_comparison_station_counts_as_analysed_and_weather_alone_does_not(self):
        results = await self.run_calls(
            call("d1", "displacement"),
            call("r1", "record_conclusions", self.conclusion("未见明显变化", station=OTHER), text="正文"),
        )
        self.assertEqual(results["r1"].status, "success")

        results = await self.run_calls(
            call("w1", "weather"),
            call("r1", "record_conclusions", self.conclusion("持续关注")),
        )
        self.assertTrue(is_tool_feedback(results["r1"]))

    async def test_conclusions_are_not_offered_as_citable_evidence(self):
        results = await self.run_calls(
            call("d1", "displacement"),
            call("r1", "record_conclusions", self.conclusion("持续关注"), text="正文"),
        )
        from app.agent.message_context import is_evidence
        self.assertFalse(is_evidence(results["r1"]))
