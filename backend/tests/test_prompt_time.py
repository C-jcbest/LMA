import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from openai import APIConnectionError, APIStatusError
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from app.agent import context, graph, reasoning, retry, site, summarization, title, tools, vision, weather
from app.agent.prompting import SYSTEM_PROMPT_TEMPLATE, VISION_PROMPT, build_system_prompt, build_time_context
from app.business_time import BUSINESS_TZ, business_now
from app.config import Settings


class PromptTimeTests(unittest.TestCase):
    def test_auxiliary_thinking_defaults_are_disabled(self):
        for field in (
            "title_thinking",
            "recommend_thinking",
            "compress_thinking",
            "vision_thinking",
        ):
            self.assertIs(Settings.model_fields[field].default, False)

    def test_recommendations_are_enabled_by_default(self):
        self.assertIs(Settings.model_fields["recommend_enabled"].default, True)

    def test_thinking_options_only_emits_extension_when_enabled(self):
        self.assertEqual(reasoning.thinking_options(False), {})
        self.assertEqual(
            reasoning.thinking_options(True),
            {"extra_body": {"enable_thinking": True}},
        )

    def test_auxiliary_models_do_not_inherit_main_thinking(self):
        settings = SimpleNamespace(
            llm_model="test-model",
            llm_api_key="test-key",
            llm_base_url="https://example.invalid/v1",
            llm_thinking=True,
            title_thinking=False,
            recommend_enabled=True,
            recommend_thinking=False,
            context_summary_max_tokens=2000,
            compress_thinking=False,
            vision_model="vision-model",
            vision_api_key="test-key",
            vision_base_url="https://example.invalid/v1",
            vision_thinking=False,
        )
        factories = (
            (title, title._get_title_llm),
            (graph, graph._get_recommend_llm),
            (summarization, summarization._get_summary_model),
            (vision, vision._get_vision_llm),
        )
        try:
            for module, factory in factories:
                factory.cache_clear()
                with patch.object(module, "get_settings", return_value=settings):
                    llm = factory()
                self.assertIsNone(llm.extra_body)
        finally:
            for _, factory in factories:
                factory.cache_clear()

    def test_reasoning_chat_model_preserves_complete_and_streamed_reasoning(self):
        llm = reasoning.ReasoningChatOpenAI(
            model="test-model",
            api_key="test-key",
            base_url="https://example.invalid/v1",
        )
        complete = llm._create_chat_result(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "结论",
                            "reasoning_content": "先核对数据。",
                        },
                        "finish_reason": "stop",
                    }
                ]
            }
        )
        self.assertEqual(
            complete.generations[0].message.additional_kwargs["reasoning_content"],
            "先核对数据。",
        )

        streamed = llm._convert_chunk_to_generation_chunk(
            {
                "choices": [
                    {
                        "delta": {"role": "assistant", "reasoning_content": "检查趋势"},
                        "finish_reason": None,
                    }
                ]
            },
            AIMessageChunk,
            None,
        )
        self.assertIsNotNone(streamed)
        self.assertEqual(
            streamed.message.additional_kwargs["reasoning_content"],
            "检查趋势",
        )

    def test_formal_prompt_files_are_the_only_sources(self):
        repo_root = Path(__file__).resolve().parents[2]
        prompt_dir = repo_root / "backend" / "app" / "agent" / "prompts"
        self.assertEqual(SYSTEM_PROMPT_TEMPLATE, (prompt_dir / "system.md").read_text(encoding="utf-8"))
        self.assertEqual(VISION_PROMPT, (prompt_dir / "vision.md").read_text(encoding="utf-8"))
        self.assertFalse((repo_root / "prompt.md").exists())

    def test_utc_rollover_and_explicit_windows(self):
        prompt = build_system_prompt("2026-09-13T16:05:00+00:00")
        self.assertIn("当前业务时间：2026-09-14 00:05:00", prompt)
        self.assertNotIn("近期默认参考窗口", build_time_context("2026-09-13T16:05:00+00:00"))
        self.assertNotIn("长期默认参考窗口", build_time_context("2026-09-13T16:05:00+00:00"))
        self.assertNotIn("{{CURRENT_TIME}}", prompt)
        self.assertIn("不主动扩展范围", prompt)
        self.assertIn("默认起点，不是固定分析窗口", prompt)

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

    def test_station_spatial_fields_and_title_are_not_truncated(self):
        station = SimpleNamespace(
            station_uuid="station-1",
            station_name="ZJ-MS10-LONG-NAME",
            group_name="示范组",
            station_type=3,
            station_status=10,
            location="贵州",
            description="",
            latitude="27.1234",
            longitude="106.5678",
            altitude="982.5",
        )
        data = tools._station_to_dict(station)
        self.assertEqual(data["coordinate_system"], "WGS84")
        self.assertEqual(data["latitude"], 27.1234)
        self.assertEqual(data["altitude"], 982.5)
        generated = "ZJ-MS10-LONG-NAME 近期形变调查"
        self.assertEqual(title.clean_generated_title(generated), generated)
        self.assertEqual(title.clean_generated_title("x" * 81), "")

        station.latitude = ""
        station.longitude = "not-a-number"
        station.altitude = None
        invalid = tools._station_to_dict(station)
        self.assertIsNone(invalid["latitude"])
        self.assertIsNone(invalid["longitude"])
        self.assertIsNone(invalid["altitude"])

    def test_retry_classifier_only_accepts_transient_failures(self):
        request = httpx.Request("GET", "https://example.invalid")
        too_many = httpx.Response(429, request=request)
        bad_request = httpx.Response(400, request=request)
        server_error = httpx.Response(503, request=request)
        self.assertTrue(retry.is_transient_error(TimeoutError()))
        self.assertTrue(retry.is_transient_error(httpx.HTTPStatusError("429", request=request, response=too_many)))
        self.assertTrue(retry.is_transient_error(httpx.HTTPStatusError("503", request=request, response=server_error)))
        self.assertFalse(retry.is_transient_error(httpx.HTTPStatusError("400", request=request, response=bad_request)))
        self.assertFalse(retry.is_transient_error(ValueError("业务参数错误")))
        self.assertTrue(retry.is_transient_error(APIConnectionError(request=request)))
        for status, expected in ((429, True), (503, True), (400, False), (401, False), (403, False)):
            error = APIStatusError("test error", response=httpx.Response(status, request=request), body=None)
            self.assertEqual(retry.is_transient_error(error), expected)

    def test_context_budget_counts_fixed_prompt_tools_and_output_reserve(self):
        settings = SimpleNamespace(
            context_token_threshold=10_000,
            context_model_context=100_000,
            context_compress_ratio=0.8,
            context_keep_messages=20,
            context_output_reserve_tokens=1000,
            context_safety_margin_tokens=200,
            context_token_estimate_factor=1.0,
            context_chars_per_token=1.6667,
            llm_model="deepseek-flash",
        )
        with patch.object(context, "get_settings", return_value=settings):
            budget = context.build_context_budget(
                [HumanMessage(content="查询监测点")],
                system_prompt="系统规则" * 100,
                bound_tools=[tools.list_stations],
            )
        self.assertGreater(budget.fixed_input_tokens, 0)
        self.assertEqual(budget.output_reserve_tokens, 1000)
        self.assertEqual(
            budget.available_history_tokens,
            budget.trigger_tokens - budget.fixed_input_tokens - 1200,
        )
        snapshot = budget.usage_snapshot(
            {"input_tokens": 321, "output_tokens": 20, "total_tokens": 341}
        )
        self.assertEqual(snapshot["counter"], "provider_reported")
        self.assertEqual(snapshot["input_tokens"], 321)
        self.assertEqual(snapshot["remaining_tokens"], 100_000 - 321 - 1200)
        self.assertEqual(
            snapshot["estimated_fixed_input_tokens"]
            + snapshot["estimated_history_tokens"]
            + snapshot["accounting_difference_tokens"],
            snapshot["input_tokens"],
        )

    def test_recommendations_require_strict_json_and_allow_model_to_decline(self):
        self.assertEqual(
            graph._parse_recommendations('["查看近期趋势", "对比同组测点"]'),
            ["查看近期趋势", "对比同组测点"],
        )
        self.assertEqual(graph._parse_recommendations("[]"), [])
        with self.assertRaises((json.JSONDecodeError, ValueError)):
            graph._parse_recommendations("1. 查看近期趋势\n2. 对比同组测点")

    def test_terrain_metrics_are_derived_from_dem_samples(self):
        elevations = [100 + i for i in range(25)] + [100, 118, 104, 122]
        metrics = site._terrain_metrics(
            elevations,
            {"west": 25, "east": 26, "south": 27, "north": 28},
        )
        self.assertIsNotNone(metrics)
        self.assertEqual(metrics["dem_elevation_m"], 112.0)
        self.assertGreater(metrics["slope_degrees"], 0)
        self.assertEqual(metrics["relief_500m_m"], 24.0)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_recommendations_skip_model_call(self):
        state = {
            "messages": [HumanMessage(content="查询站点"), AIMessage(content="查询完成")],
            "business_time": "2026-09-14T10:00:00+08:00",
        }
        settings = SimpleNamespace(recommend_enabled=False)
        with patch.object(graph, "get_settings", return_value=settings), patch.object(
            graph, "_get_recommend_llm"
        ) as get_llm:
            update = await graph.generate_recommendations(state)
        self.assertEqual(update["recommendations"], [])
        self.assertEqual(update["recommendations_error"], "")
        get_llm.assert_not_called()

    async def test_site_environment_returns_versioned_artifact(self):
        station = SimpleNamespace(
            station_uuid="station-1",
            station_name="ZJ-MS10",
            group_uuid="group-1",
            group_name="示范组",
            station_type=3,
            station_status=10,
            location="贵州",
            description="",
            latitude=27.1,
            longitude=106.5,
            altitude=980,
        )
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = [station]
        terrain = {"dem_elevation_m": 981.0, "slope_degrees": 12.5}
        geology = {"name": "测试地层", "lithology": "砂岩"}
        with (
            patch.object(site, "_build_client", return_value=client),
            patch.object(site, "_resolve_station", AsyncMock(return_value=station)),
            patch.object(site, "_fetch_terrain", AsyncMock(return_value=(terrain, None))),
            patch.object(site, "_fetch_geology", AsyncMock(return_value=(geology, None))),
        ):
            content, artifact = await site.inspect_site_environment.coroutine("ZJ-MS10")
        self.assertTrue(json.loads(content)["ok"])
        environment = artifact["site_environment"]
        self.assertEqual(environment["version"], 1)
        self.assertEqual(environment["coordinate_system"], "WGS84")
        self.assertEqual(environment["center_station"]["station_name"], "ZJ-MS10")
        self.assertEqual(environment["terrain"], terrain)
        self.assertEqual(environment["geology"], geology)

    async def test_invalid_title_is_reported_instead_of_fabricated(self):
        with self.assertRaises(ValueError):
            await title.generate_title_node({"input_text": "   ", "title": ""})

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

    async def test_invalid_sampling_frequency_is_not_silently_replaced(self):
        with patch.object(tools, "_build_client") as build_client:
            result = await tools.get_daily_gnss_data.ainvoke(
                {
                    "station_name_or_uuid": "测试站",
                    "begin_time": "2026-09-01 00:00:00",
                    "end_time": "2026-09-02 00:00:00",
                    "sampling_frequency": "sometimes",
                }
            )
        self.assertIn("无法识别", result)
        build_client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
