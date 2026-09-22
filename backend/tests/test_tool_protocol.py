"""生产工具协议：错误状态、请求前校验、部分证据与不可公开诊断。"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch



import httpx
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.messages.utils import convert_to_openai_messages
from langchain_core.tools import tool
from app.agent import graph, summarization, tools, vision, weather, site
from app.agent.tool_protocol import tool_error_result, tool_result
from runtime_fixtures import ScriptedModel


class ToolProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(recommend_enabled=False, agent_max_retries=2, agent_retry_initial_delay=0.5, agent_retry_max_delay=4.0,
            agent_model_run_limit=20, agent_tool_run_limit=40, llm_model="test", context_token_threshold=800000,
            context_model_context=1048576, context_keep_tokens=400000, context_summary_max_tokens=2000)
        for module in (graph, summarization):
            patcher = patch.object(module, "get_settings", return_value=settings)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def run_tool(self, agent_tool, args):
        model = ScriptedModel(script=[AIMessage(content="", tool_calls=[{
            "id": "call", "name": agent_tool.name, "args": args}]), AIMessage(content="依据可用证据继续说明")])
        agent = graph.create_lma_agent(model, agent_tools=[agent_tool], retry_delay=0,
            summary_model=ScriptedModel(script=[]))
        result = await agent.ainvoke({"messages": [{"role": "user", "content": "查询监测证据"}]})
        message = next(m for m in result["messages"] if isinstance(m, ToolMessage))
        self.assertEqual(result["messages"][-1].content, "依据可用证据继续说明")
        return message, model

    def test_injected_tool_call_id_is_not_exposed_to_model(self):
        for agent_tool in (site.inspect_site_environment, vision.analyze_gnss_chart):
            with self.subTest(tool=agent_tool.name):
                schema = agent_tool.tool_call_schema.model_json_schema()
                self.assertNotIn("tool_call_id", schema.get("properties", {}))
                self.assertNotIn("tool_call_id", schema.get("required", []))

    def test_partial_error_envelope_keeps_canonical_error_status(self):
        message, artifact = tool_error_result(
            "仅取得部分证据",
            tool_call_id="call-partial",
            tool_name="partial_tool",
            kind="generic",
            data={
                "current_time": "2026-09-21 12:00:00",
                "timezone": "Asia/Shanghai",
            },
        )
        self.assertEqual(message.status, "error")
        self.assertIs(message.artifact, artifact)
        self.assertEqual(artifact["version"], 1)
        self.assertEqual(artifact["kind"], "generic")
        self.assertEqual(artifact["status"], "error")
        self.assertEqual(artifact["error"]["message"], "仅取得部分证据")

    async def test_station_not_found_is_error_and_model_can_continue(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = []
        with patch.object(tools, "_build_client", return_value=client):
            message, _ = await self.run_tool(tools.get_daily_gnss_data, {
                "station_name_or_uuid": "不存在的站点", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "error")
        self.assertIn("未找到", message.content)
        self.assertIsNone(message.artifact)
        self.assertEqual(client.get_stations.await_count, 1)
        client.get_daily_data.assert_not_called()

    async def test_missing_group_filter_returns_successful_empty_station_list(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_station_groups.return_value = []
        with patch.object(tools, "_build_client", return_value=client):
            message, _ = await self.run_tool(
                tools.list_stations,
                {"group_name": "不存在的分组"},
            )
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["status"], "success")
        self.assertEqual(message.artifact["data"]["stations"], [])
        client.get_stations.assert_not_called()

    async def test_invalid_args_never_access_source(self):
        base = {"station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00"}
        cases = [(tools.get_daily_gnss_data, {**base, **invalid}) for invalid in [
            {"begin_time": "secret://internal"}, {"end_time": base["begin_time"]},
            {"sampling_frequency": "sometimes"}, {"old_option": True}, {"sample_times": []}, {"sample_times": ["15:30"]}]]
        cases += [(tools.list_stations, {"station_status": 999}),
                  (weather.query_weather, {"latitude": 30}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": 17}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": -1}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "1939-12-31", "end_date": "1940-01-05"}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "2026-08-01", "end_date": "2026-09-05"})]
        with patch.object(tools, "_build_client") as source, patch.object(weather, "_fetch_json") as fetch:
            for agent_tool, args in cases:
                with self.subTest(tool=agent_tool.name, args=args):
                    message, _ = await self.run_tool(agent_tool, args)
                    self.assertEqual(message.status, "error")
                    self.assertIn("参数", message.content)
                    self.assertIsNone(message.artifact)
                    self.assertNotIn("secret://", str(message))
            source.assert_not_called()
            fetch.assert_not_called()

    async def test_empty_data_returns_success_status_and_zero_points(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = []
        with patch.object(tools, "_build_client", return_value=client), patch.object(tools, "_resolve_station",
            AsyncMock(return_value=SimpleNamespace(station_name="测试站", station_type=3, station_uuid="test"))):
            message, _ = await self.run_tool(tools.get_daily_gnss_data, {
                "station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["total_points"], 0)
        self.assertEqual(message.artifact["data"]["points"], [])
        self.assertEqual(message.artifact["data"]["summary"]["n"]["count"], 0)
        self.assertNotIn("message", message.artifact["data"])
        self.assertEqual(client.get_daily_data.await_count, 1)

    async def test_empty_visual_data_returns_success_without_model_call(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = []
        station = SimpleNamespace(
            station_name="测试站",
            station_type=3,
            station_uuid="test",
        )
        with patch.object(vision, "_build_client", return_value=client), patch.object(
            vision, "_resolve_station", AsyncMock(return_value=station)
        ), patch.object(vision, "_get_vision_llm") as vision_model:
            message, _ = await self.run_tool(
                vision.analyze_gnss_chart,
                {
                    "station_name_or_uuid": "测试站",
                    "begin_time": "2026-09-01 00:00:00",
                    "end_time": "2026-09-02 00:00:00",
                },
            )
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["status"], "success")
        self.assertEqual(message.artifact["data"]["total_points"], 0)
        self.assertEqual(message.artifact["data"]["chart_points"], [])
        self.assertEqual(message.artifact["data"]["images"], [])
        self.assertNotIn("message", message.artifact["data"])
        vision_model.assert_not_called()

    async def test_internal_error_is_logged_but_never_exposed(self):
        @tool
        def broken():
            """测试内部异常。"""
            raise RuntimeError("secret://host/private?token=TEST_PRIVATE")
        with self.assertLogs(graph.logger, level="WARNING") as logs:
            message, model = await self.run_tool(broken, {})
        self.assertEqual(message.status, "error")
        self.assertIn("TEST_PRIVATE", "\n".join(logs.output))
        self.assertNotIn("TEST_PRIVATE", str(message))
        self.assertNotIn("TEST_PRIVATE", str(model.inputs))

    async def test_transient_error_retries_then_returns_controlled_error(self):
        calls = []
        @tool
        def unavailable():
            """测试瞬时失败。"""
            calls.append(1)
            raise httpx.ConnectError("secret://host?token=TEST_PRIVATE")
        with self.assertLogs(graph.logger, level="WARNING"):
            message, _ = await self.run_tool(unavailable, {})
        self.assertEqual(len(calls), 3)
        self.assertEqual(message.status, "error")
        self.assertIn("暂不可用", message.content)
        self.assertIsNone(message.artifact)
        self.assertNotIn("TEST_PRIVATE", str(message))

    async def test_empty_site_evidence_returns_standard_success(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = []
        with patch.object(site, "_build_client", return_value=client), \
             patch.object(site, "_resolve_station", AsyncMock(return_value=SimpleNamespace(group_uuid="group"))), \
             patch.object(site, "_station_to_dict", return_value={"station_name": "测试站", "latitude": 30, "longitude": 120}), \
             patch.object(site, "_fetch_terrain", AsyncMock(return_value=({"slope_degrees": 12}, None))), \
             patch.object(site, "_fetch_geology", AsyncMock(return_value=(None, None))):
            message, _ = await self.run_tool(site.inspect_site_environment, {"station_name_or_uuid": "测试站"})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["status"], "success")
        self.assertEqual(message.artifact["data"]["terrain"]["slope_degrees"], 12)
        self.assertIsNone(message.artifact["data"].get("geology"))
        self.assertNotIn("error", message.artifact)
        self.assertEqual(message.artifact["limitations"], [])

    async def test_weather_forecast_days_zero_is_valid(self):
        fetch = AsyncMock(side_effect=[
            {"current": {"temperature_2m": 22, "wind_speed_10m": 5}, "daily": {}},
            {"daily": {}},
        ])
        with patch.object(weather, "_fetch_json", fetch):
            message, _ = await self.run_tool(weather.query_weather, {
                "latitude": 30, "longitude": 120, "forecast_days": 0
            })
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["query"]["forecast_days"], 0)

    async def test_empty_weather_payload_returns_success(self):
        with patch.object(weather, "_fetch_json", AsyncMock(return_value={})):
            message, _ = await self.run_tool(
                weather.query_weather,
                {"latitude": 30, "longitude": 120},
            )
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["status"], "success")
        self.assertIsNone(message.artifact["data"].get("current"))
        self.assertIsNone(message.artifact["data"]["rain_summary"].get("history_total_precipitation"))
        self.assertIsNone(message.artifact["data"]["rain_summary"].get("forecast_total_precipitation"))
        self.assertEqual(message.artifact["data"]["history"]["daily"]["time"], [])
        self.assertEqual(message.artifact["data"]["forecast"]["daily"]["time"], [])
        self.assertNotIn("message", message.artifact["data"])

    async def test_site_evidence_isolates_external_network_failures(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = []
        request = httpx.Request("GET", "https://example.invalid")
        response = httpx.Response(503, request=request)
        mock_fetch = AsyncMock(side_effect=[
            httpx.HTTPStatusError("Service Unavailable", request=request, response=response),
            {"success": {"data": [{"name": "泥盆系灰岩", "lith": "石灰岩"}], "refs": {}}},
        ])
        with patch.object(site, "_build_client", return_value=client), \
             patch.object(site, "_resolve_station", AsyncMock(return_value=SimpleNamespace(group_uuid="group"))), \
             patch.object(site, "_station_to_dict", return_value={"station_name": "测试站", "latitude": 30, "longitude": 120}), \
             patch.object(site, "_fetch_json", mock_fetch):
            message, _ = await self.run_tool(site.inspect_site_environment, {"station_name_or_uuid": "测试站"})
        self.assertEqual(message.status, "error")
        # 即使地形网络发生 503 异常，地质有效证据绝不被抹掉
        self.assertEqual(message.artifact["data"]["geology"]["name"], "泥盆系灰岩")
        self.assertIsNone(message.artifact["data"].get("terrain"))
        self.assertIn("缺少地形证据", message.artifact["error"]["message"])

    async def test_unconfigured_vision_preserves_charts_with_error_status(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = [SimpleNamespace(data_time=f"2026-09-01 0{i}:00:00", n="1", e="2", u="3") for i in range(5)]
        station = SimpleNamespace(station_type=3, station_uuid="test", station_name="测试站")
        with patch.object(vision, "_build_client", return_value=client), \
             patch.object(vision, "_resolve_station", AsyncMock(return_value=station)), \
             patch.object(vision, "_resolve_baseline", return_value=None), \
             patch.object(vision, "_render_all_charts", return_value=[{"name": "raw_coordinates", "png_base64": "TEST_IMAGE"}]), \
             patch.object(vision, "get_settings", return_value=SimpleNamespace(vision_base_url="", vision_api_key="", vision_model="")):
            message, _ = await self.run_tool(vision.analyze_gnss_chart, {"station_name_or_uuid": "测试站",
                "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "error")
        self.assertEqual(len(message.artifact["data"]["chart_points"]), 5)
        self.assertEqual(message.artifact["data"]["station_name"], "测试站")
        self.assertIn("未配置", message.artifact["error"]["message"])
        self.assertNotIn("VISION_", message.content)
        self.assertNotIn("TEST_IMAGE", str(convert_to_openai_messages([message])))

    async def test_success_artifact_not_serialized_to_model(self):
        @tool(response_format="content_and_artifact")
        def evidence():
            """测试模型事实与展示序列分离。"""
            return tool_result(
                {"station_name": "测试站", "net_change_mm": 2},
                kind="vision",
                display={
                    "station_name": "测试站",
                    "begin_time": "2026-09-21 00:00:00",
                    "end_time": "2026-09-21 01:00:00",
                    "timezone": "Asia/Shanghai",
                    "total_points": 1,
                    "images": [],
                    "chart_points": [{"t": "DISPLAY_ONLY", "n": 1, "e": 2, "u": 3}],
                },
            )
        message, _ = await self.run_tool(evidence, {})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["chart_points"][0]["t"], "DISPLAY_ONLY")
        self.assertNotIn("DISPLAY_ONLY", str(convert_to_openai_messages([message])))
        self.assertIn("net_change_mm", message.content)

    async def test_vision_invalid_output_and_excess_candidates_do_not_retry(self):
        for output in ("not-json", "many"):
            with self.subTest(output=output):
                client = AsyncMock()
                client.__aenter__.return_value = client
                client.get_daily_data.return_value = [SimpleNamespace(data_time=f"2026-09-01 0{i}:00:00", n="1", e="2", u="3") for i in range(5)]
                station = SimpleNamespace(station_type=3, station_uuid="test", station_name="测试站")
                observations = vision.VisionObservations(candidates=[vision.VisualCandidate(metric="N",
                    start_at="2026-09-01 01:00:00", end_at="2026-09-01 02:00:00") for _ in range(2)])
                if output == "not-json":
                    structured_result = {"raw": AIMessage(content="not-json"), "parsed": None, "parsing_error": ValueError("not json")}
                else:
                    structured_result = {"raw": AIMessage(content="{}"), "parsed": observations, "parsing_error": None}
                bound_structured = SimpleNamespace(ainvoke=AsyncMock(return_value=structured_result))
                model = SimpleNamespace(with_structured_output=MagicMock(return_value=bound_structured))
                settings = SimpleNamespace(vision_base_url="https://test.invalid", vision_api_key="INVALID", vision_model="test", vision_max_candidates=1)
                with patch.object(vision, "_build_client", return_value=client), \
                     patch.object(vision, "_resolve_station", AsyncMock(return_value=station)), \
                     patch.object(vision, "_resolve_baseline", return_value=None), \
                     patch.object(vision, "_render_all_charts", return_value=[{"name": "cumulative_displacement", "png_base64": "TEST"}]), \
                     patch.object(vision, "get_settings", return_value=settings), \
                     patch.object(vision, "_get_vision_llm", return_value=model), \
                     patch.object(vision, "_recheck_candidates", new_callable=AsyncMock) as recheck:
                    message, _ = await self.run_tool(vision.analyze_gnss_chart, {"station_name_or_uuid": "测试站",
                        "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"})
                self.assertEqual(message.status, "error")
                self.assertEqual(bound_structured.ainvoke.await_count, 1)
                recheck.assert_not_called()
                self.assertEqual(len(message.artifact["data"]["chart_points"]), 5)

    async def test_empty_vision_observation_returns_standard_success(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = [
            SimpleNamespace(
                data_time=f"2026-09-01 0{i}:00:00",
                n="1",
                e="2",
                u="3",
            )
            for i in range(5)
        ]
        station = SimpleNamespace(
            station_type=3,
            station_uuid="test",
            station_name="测试站",
        )
        structured_result = {
            "raw": AIMessage(content="{}"),
            "parsed": vision.VisionObservations(),
            "parsing_error": None,
        }
        bound_structured = SimpleNamespace(
            ainvoke=AsyncMock(return_value=structured_result)
        )
        model = SimpleNamespace(
            with_structured_output=MagicMock(return_value=bound_structured)
        )
        settings = SimpleNamespace(
            vision_base_url="https://test.invalid",
            vision_api_key="INVALID",
            vision_model="test",
            vision_max_candidates=1,
            vision_recheck_pad_hours=2,
        )
        with patch.object(vision, "_build_client", return_value=client), patch.object(
            vision, "_resolve_station", AsyncMock(return_value=station)
        ), patch.object(vision, "_resolve_baseline", return_value=None), patch.object(
            vision,
            "_render_all_charts",
            return_value=[{"name": "cumulative_displacement", "png_base64": "TEST"}],
        ), patch.object(vision, "get_settings", return_value=settings), patch.object(
            vision, "_get_vision_llm", return_value=model
        ), patch.object(
            vision, "_recheck_candidates", new_callable=AsyncMock
        ) as recheck:
            message, _ = await self.run_tool(
                vision.analyze_gnss_chart,
                {
                    "station_name_or_uuid": "测试站",
                    "begin_time": "2026-09-01 00:00:00",
                    "end_time": "2026-09-02 00:00:00",
                },
            )
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["status"], "success")
        self.assertNotIn("error", message.artifact)
        self.assertEqual(message.artifact["data"]["observations"]["candidates"], [])
        self.assertNotIn("message", message.artifact["data"])
        recheck.assert_awaited_once()


    async def test_get_current_time_success_in_agent_run(self):
        message, _ = await self.run_tool(tools.get_current_time, {})
        self.assertEqual(message.status, "success")
        self.assertIn("current_time", message.artifact["data"])
        self.assertEqual(message.artifact["data"]["timezone"], "Asia/Shanghai")
