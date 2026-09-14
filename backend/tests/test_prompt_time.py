import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage

from app.agent import context, graph, tools, vision, weather
from app.agent.prompting import SYSTEM_PROMPT_TEMPLATE, VISION_PROMPT, build_system_prompt
from app.business_time import BUSINESS_TZ, business_now


class PromptTimeTests(unittest.TestCase):
    def test_templates_match_business_source(self):
        source = (Path(__file__).resolve().parents[2] / "prompt.md").read_text(encoding="utf-8-sig")
        system, visual = source.split("# VISION_PROMPT", 1)
        self.assertEqual(SYSTEM_PROMPT_TEMPLATE.strip(), system.removeprefix("# SYSTEM_PROMPT").strip())
        self.assertTrue(VISION_PROMPT.startswith(visual.strip()))

    def test_utc_rollover_and_explicit_windows(self):
        prompt = build_system_prompt("2026-09-13T16:05:00+00:00")
        self.assertIn("当前业务时间：2026-09-14 00:05:00", prompt)
        self.assertIn("2026-09-07 00:05:00 至 2026-09-14 00:05:00", prompt)
        self.assertIn("2026-06-16 00:05:00 至 2026-09-14 00:05:00", prompt)
        self.assertNotIn("{{CURRENT_TIME}}", prompt)
        self.assertIn("只看指定时段", prompt)

    def test_leap_day_and_year_boundary(self):
        self.assertIn("“昨天”：2024-02-29", build_system_prompt("2024-03-01T00:00:00+08:00"))
        self.assertIn("“昨天”：2025-12-31", build_system_prompt("2026-01-01T00:00:00+08:00"))

    def test_clock_is_aware_and_naive_anchor_rejected(self):
        self.assertEqual(business_now().utcoffset(), timedelta(hours=8))
        with self.assertRaises(ValueError):
            build_system_prompt("2026-09-14T00:00:00")

    def test_recent_rain_excludes_future_and_handles_missing(self):
        now = datetime(2026, 9, 14, 0, 5, tzinfo=BUSINESS_TZ)
        start = now.replace(minute=0) - timedelta(hours=24)
        payload = {"hourly": {
            "time": [(start + timedelta(hours=i)).isoformat() for i in range(49)],
            "precipitation": [100] + [1] * 24 + [100] * 24,
        }}
        result = weather._recent_precipitation(payload, now)
        self.assertEqual(result["precipitation"], 24)
        self.assertTrue(result["complete"])
        payload["hourly"]["precipitation"][5] = None
        result = weather._recent_precipitation(payload, now)
        self.assertIsNone(result["precipitation"])
        self.assertEqual(result["available_hours"], 23)
        self.assertIsNone(weather._recent_precipitation({}, now)["precipitation"])


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_compression_separates_historical_data_from_instructions(self):
        llm = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content="摘要")))
        with patch.object(context, "_get_compress_llm", return_value=llm):
            result = await context.compress_history(["用户：今天如何"], "此前视觉候选，尚未确认")
        self.assertEqual(result, "摘要")
        messages = llm.ainvoke.call_args.args[0]
        self.assertEqual([m.type for m in messages], ["system", "human", "human"])
        self.assertIn("缺少锚点不得推算", messages[0].content)
        self.assertIn("不得将视觉候选改写为已确认异常", messages[0].content)

    async def test_turn_refresh_loop_stability_and_recommendations(self):
        first = datetime(2026, 9, 13, 23, 59, tzinfo=BUSINESS_TZ)
        second = first + timedelta(minutes=2)
        state = {"messages": [HumanMessage(content="今天怎么样")], "context_summary": "旧摘要"}
        with patch.object(graph, "manage_context", AsyncMock(return_value={})), patch.object(graph, "business_now", side_effect=[first, second]):
            state.update(await graph.manage_context_node(state))
            llm = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content="需核查")))
            with patch.object(graph, "_get_llm_with_tools", return_value=llm):
                await graph.agent_node(state)
                await graph.agent_node(state)
            calls = llm.ainvoke.call_args_list
            self.assertEqual(calls[0].args[0][0].content, calls[1].args[0][0].content)
            self.assertEqual(calls[0].args[0][1].type, "human")
            self.assertEqual(len(state["messages"]), 1)
            state["messages"].append(AIMessage(content="需要继续复核"))
            with patch.object(graph, "_get_recommend_llm", return_value=llm):
                await graph.recommend_node(state)
            self.assertIn("2026-09-13 23:59:00", llm.ainvoke.call_args.args[0][0].content)
            state.update(await graph.manage_context_node(state))
            self.assertEqual(state["business_time"], second.isoformat(timespec="seconds"))

    async def test_weather_default_window_uses_business_day(self):
        now = datetime(2026, 9, 14, 0, 5, tzinfo=BUSINESS_TZ)
        fetch = AsyncMock(return_value={})
        with patch.object(weather, "business_now", return_value=now), patch.object(weather, "_fetch_json", fetch):
            result = json.loads(await weather.query_weather.ainvoke({"latitude": 30, "longitude": 120}))
        self.assertEqual(result["query"]["history_end_date"], "2026-09-13")
        self.assertEqual(result["query"]["history_start_date"], "2026-09-07")
        self.assertTrue(all(c.args[1]["timezone"] == "Asia/Shanghai" for c in fetch.call_args_list))
        self.assertIsNone(result["rain_summary"]["recent_24h_precipitation"])

    async def test_base_station_does_not_query_deformation(self):
        for module, tool in ((tools, tools.get_daily_gnss_data), (vision, vision.analyze_gnss_chart)):
            client = AsyncMock()
            client.__aenter__.return_value = client
            with patch.object(module, "_build_client", return_value=client), patch.object(module, "_resolve_station", AsyncMock(return_value=SimpleNamespace(station_type=1))):
                result = await tool.ainvoke({"station_name_or_uuid": "基准站", "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-14 00:00:00"})
            self.assertIn("基准站", result)
            client.get_daily_data.assert_not_called()


if __name__ == "__main__":
    unittest.main()
