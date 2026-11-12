"""生产工具协议：错误状态、请求前校验、部分证据与不可公开诊断。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch


import httpx
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.messages.utils import convert_to_openai_messages
from langchain_core.tools import tool
from app.agent import graph, summarization, tools, weather, site
from app.agent.tool_protocol import ToolFailure, tool_error_result, tool_result
from app.beidou.schemas import GnssDataPoint, Station
from app.monitoring_data import MonitoringData, _SeriesCache


def station(name="测试站", uuid="11111111-1111-1111-1111-111111111111", **values):
    return Station(station_uuid=uuid, station_name=name, station_type=values.pop("station_type", 3),
                   group_uuid="group", group_name="测试组", **values)


def hourly_points(count):
    return [GnssDataPoint(data_time=f"2026-09-01 0{i}:00:00", n="1", e="2", u="3") for i in range(count)]
from runtime_fixtures import FakePlatform, ScriptedModel


class ToolProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(agent_max_retries=2, agent_retry_initial_delay=0.5, agent_retry_max_delay=4.0,
            agent_model_run_limit=20, agent_tool_run_limit=40, llm_model="test", context_token_threshold=800000,
            context_model_context=1048576, context_keep_tokens=400000, context_summary_max_tokens=2000)
        for module in (graph, summarization):
            patcher = patch.object(module, "get_settings", return_value=settings)
            patcher.start()
            self.addCleanup(patcher.stop)

    def use_platform(self, platform):
        patcher = patch("app.monitoring_data.build_platform_client", return_value=platform)
        patcher.start()
        self.addCleanup(patcher.stop)
        return platform

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
        for agent_tool in (site.inspect_site_environment,):
            with self.subTest(tool=agent_tool.name):
                schema = agent_tool.tool_call_schema.model_json_schema()
                self.assertNotIn("tool_call_id", schema.get("properties", {}))
                self.assertNotIn("tool_call_id", schema.get("required", []))

    async def test_upstream_data_validation_is_not_classified_as_model_input_feedback(self):
        from pydantic import BaseModel
        from app.agent.tool_feedback import is_tool_feedback
        from app.server.messages import project_message

        class PlatformData(BaseModel):
            coordinate: float

        @tool
        def read_platform_data() -> str:
            """读取平台返回的数据。"""
            PlatformData.model_validate({'coordinate': 'PRIVATE_PLATFORM_VALUE'})
            return 'unreachable'

        message, _ = await self.run_tool(read_platform_data, {})
        self.assertEqual(message.status, 'error')
        self.assertFalse(is_tool_feedback(message))
        self.assertNotIn('PRIVATE_PLATFORM_VALUE', str(project_message(message)))

    def test_partial_error_envelope_keeps_canonical_error_status(self):
        message, artifact = tool_error_result(
            "仅取得部分证据",
            tool_call_id="call-partial",
            tool_name="partial_tool",
            kind="station_list",
            data={
                "total": 0, "stations": [],
            },
        )
        self.assertEqual(message.status, "error")
        self.assertIs(message.artifact, artifact)
        self.assertEqual(artifact["version"], 1)
        self.assertEqual(artifact["kind"], "station_list")
        self.assertEqual(artifact["status"], "error")
        self.assertEqual(artifact["error"]["message"], "仅取得部分证据")

    async def test_station_not_found_is_error_and_model_can_continue(self):
        platform = self.use_platform(FakePlatform())
        message, _ = await self.run_tool(tools.get_displacement, {
            "station_name_or_uuid": "不存在的站点", "begin_time": "2026-09-01 00:00:00",
            "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "error")
        self.assertIn("未找到", message.content)
        self.assertIsNone(message.artifact)
        self.assertEqual(platform.requests, [])

    async def test_unknown_group_is_reported_for_the_model_to_correct(self):
        self.use_platform(FakePlatform(stations=[station()]))
        message, _ = await self.run_tool(tools.find_stations, {"group_name": "不存在的分组"})
        self.assertEqual(message.status, "error")
        self.assertIn("未找到", message.content)

    async def test_find_stations_returns_groups_and_stations_together(self):
        from app.beidou.schemas import StationGroup
        group = StationGroup(group_uuid="group", group_name="测试组", station_count=1)
        self.use_platform(FakePlatform(stations=[station(latitude="30.1", longitude="103.2")], groups=[group]))
        message, _ = await self.run_tool(tools.find_stations, {"group_name": "测试"})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["groups"][0]["group_name"], "测试组")
        self.assertEqual(message.artifact["data"]["stations"][0]["latitude"], 30.1)

    async def test_invalid_args_never_access_source(self):
        base = {"station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00"}
        cases = [(tools.get_displacement, {**base, **invalid}) for invalid in [
            {"begin_time": "secret://internal"}, {"end_time": base["begin_time"]}, {"old_option": True},
            {"sampling": "daily", "sample_times": []}, {"sampling": "daily", "sample_times": ["15:30"]},
            {"sample_times": ["15:00"]}, {"split_time": "2026-09-03 00:00:00"}]]
        cases += [(tools.find_stations, {"station_status": 999}),
                  (weather.query_weather, {"latitude": 30}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": 17}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": -1}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "1939-12-31", "end_date": "1940-01-05"}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "2025-01-01", "end_date": "2026-09-05"})]
        platform = self.use_platform(FakePlatform(stations=[station()]))
        with patch.object(weather, "_fetch_json") as fetch:
            for agent_tool, args in cases:
                with self.subTest(tool=agent_tool.name, args=args):
                    message, _ = await self.run_tool(agent_tool, args)
                    self.assertEqual(message.status, "error")
                    self.assertIn("参数", message.content)
                    self.assertIsNone(message.artifact)
                    self.assertNotIn("secret://", str(message))
            fetch.assert_not_called()
        self.assertEqual(platform.requests, [])

    async def test_exact_station_name_wins_over_longer_names_containing_it(self):
        platform = FakePlatform(stations=[station("MS10", "uuid-10"), station("MS1", "uuid-1")])
        data = MonitoringData(_SeriesCache(), lambda: platform)
        self.assertEqual((await data.resolve_station("MS1")).station_uuid, "uuid-1")
        with self.assertRaises(ToolFailure):
            await data.resolve_station("MS")

    async def test_empty_data_returns_success_status_and_zero_points(self):
        platform = self.use_platform(FakePlatform(stations=[station(latitude="30.1", longitude="103.2")]))
        message, _ = await self.run_tool(tools.get_displacement, {
            "station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["total_points"], 0)
        self.assertEqual(message.artifact["data"]["points"], [])
        self.assertEqual(message.artifact["data"]["summary"]["n"]["count"], 0)
        self.assertEqual(json.loads(message.content)["quality"]["missing_samples"], 25)
        # 位置只给界面绘制地图，不增加模型上下文。
        self.assertEqual(message.artifact["data"]["location"], {
            "group_name": "测试组", "latitude": 30.1, "longitude": 103.2, "coordinate_system": "WGS84",
        })
        self.assertNotIn("latitude", message.content)
        self.assertEqual(len(platform.requests), 1)

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
        self.use_platform(FakePlatform(stations=[station(latitude="30", longitude="120")]))
        with patch.object(site, "_fetch_terrain", AsyncMock(return_value=({"slope_degrees": 12}, None))), \
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
        self.assertIsNone(message.artifact["data"].get("forecast"))

    async def test_long_hourly_weather_stays_in_evidence_but_not_in_model_context(self):
        hours = [f"2026-08-{day:02d}T{hour:02d}:00" for day in range(1, 11) for hour in range(24)]
        fetch = AsyncMock(side_effect=[
            {"current": {}, "daily": {}},
            {"daily": {"time": ["2026-08-01"], "precipitation_sum": [3.2]},
             "hourly": {"time": hours, "precipitation": [0.1] * len(hours)}},
        ])
        with patch.object(weather, "_fetch_json", fetch):
            message, _ = await self.run_tool(weather.query_weather, {
                "latitude": 30, "longitude": 120, "start_date": "2026-08-01", "end_date": "2026-08-10", "hourly": True,
            })
        self.assertEqual(len(message.artifact["data"]["history"]["hourly"]["time"]), 240)
        content = json.loads(message.content)
        self.assertNotIn("hourly", content["history"])
        self.assertIn("hourly_note", content["history"])
        self.assertEqual(fetch.await_args_list[1].args[1]["hourly"], "precipitation")

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
        self.assertEqual(message.artifact["data"]["history"]["daily"]["time"], [])
        self.assertIsNone(message.artifact["data"].get("forecast"))
        self.assertNotIn("message", message.artifact["data"])

    async def test_site_evidence_isolates_external_network_failures(self):
        self.use_platform(FakePlatform(stations=[station(latitude="30", longitude="120")]))
        request = httpx.Request("GET", "https://example.invalid")
        response = httpx.Response(503, request=request)
        mock_fetch = AsyncMock(side_effect=[
            httpx.HTTPStatusError("Service Unavailable", request=request, response=response),
            {"success": {"data": [{"name": "泥盆系灰岩", "lith": "石灰岩"}], "refs": {}}},
        ])
        with patch.object(site, "_fetch_json", mock_fetch):
            message, _ = await self.run_tool(site.inspect_site_environment, {"station_name_or_uuid": "测试站"})
        self.assertEqual(message.status, "error")
        # 即使地形网络发生 503 异常，地质有效证据绝不被抹掉
        self.assertEqual(message.artifact["data"]["geology"]["name"], "泥盆系灰岩")
        self.assertIsNone(message.artifact["data"].get("terrain"))
        self.assertIn("缺少地形证据", message.artifact["error"]["message"])

    async def test_success_artifact_not_serialized_to_model(self):
        @tool(response_format="content_and_artifact")
        def evidence():
            """测试模型事实与展示序列分离。"""
            return tool_result(
                {"station_name": "测试站", "net_change_mm": 2},
                kind="computation",
                display={
                    "description": "测试计算",
                    "code": "result = 1",
                    "inputs": [],
                    "result": {"t": "DISPLAY_ONLY"},
                    "truncated": False,
                },
            )
        message, _ = await self.run_tool(evidence, {})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["data"]["result"]["t"], "DISPLAY_ONLY")
        self.assertNotIn("DISPLAY_ONLY", str(convert_to_openai_messages([message])))
        self.assertIn("net_change_mm", message.content)

