"""生产工具协议：错误状态、请求前校验、部分证据与不可公开诊断。"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.messages.utils import convert_to_openai_messages
from langchain_core.tools import tool
from app.agent import graph, context, summarization, tools, vision, weather, site
from app.agent.tool_protocol import tool_result
from runtime_fixtures import ScriptedModel


class ToolProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(recommend_enabled=False, llm_model="test", context_token_threshold=800000,
            context_model_context=1048576, context_keep_tokens=400000, context_summary_max_tokens=2000,
            context_output_reserve_tokens=100, context_safety_margin_tokens=20,
            context_token_estimate_factor=1.0, context_chars_per_token=1.6667)
        for module in (graph, context, summarization):
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

    async def test_station_not_found_is_error_and_model_can_continue(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = []
        with patch.object(tools, "_build_client", return_value=client):
            message, _ = await self.run_tool(tools.get_daily_gnss_data, {
                "station_name_or_uuid": "不存在的站点", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "error")
        self.assertIn("未找到", message.artifact["data"]["message"])
        self.assertEqual(client.get_stations.await_count, 1)
        client.get_daily_data.assert_not_called()

    async def test_invalid_args_never_access_source(self):
        base = {"station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00"}
        cases = [(tools.get_daily_gnss_data, {**base, **invalid}) for invalid in [
            {"begin_time": "secret://internal"}, {"end_time": base["begin_time"]},
            {"sampling_frequency": "sometimes"}, {"old_option": True}, {"sample_times": []}, {"sample_times": ["15:30"]}]]
        cases += [(tools.list_stations, {"station_status": 999}),
                  (weather.query_weather, {"latitude": 30}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": 17}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "forecast_days": 0}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "1939-12-31", "end_date": "1940-01-05"}),
                  (weather.query_weather, {"latitude": 30, "longitude": 120, "start_date": "2026-08-01", "end_date": "2026-09-05"})]
        with patch.object(tools, "_build_client") as source, patch.object(weather, "_fetch_json") as fetch:
            for agent_tool, args in cases:
                with self.subTest(tool=agent_tool.name, args=args):
                    message, _ = await self.run_tool(agent_tool, args)
                    self.assertEqual(message.status, "error")
                    self.assertIn("参数", message.artifact["data"]["message"])
                    self.assertNotIn("secret://", str(message))
            source.assert_not_called()
            fetch.assert_not_called()

    async def test_empty_data_is_business_error_without_retry(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_daily_data.return_value = []
        with patch.object(tools, "_build_client", return_value=client), patch.object(tools, "_resolve_station",
            AsyncMock(return_value=SimpleNamespace(station_type=3, station_uuid="test"))):
            message, _ = await self.run_tool(tools.get_daily_gnss_data, {
                "station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00", "end_time": "2026-09-02 00:00:00"})
        self.assertEqual(message.status, "error")
        self.assertIn("没有 GNSS 数据", message.content)
        self.assertEqual(client.get_daily_data.await_count, 1)

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
        self.assertIn("暂不可用", message.artifact["data"]["message"])
        self.assertNotIn("TEST_PRIVATE", str(message))

    async def test_partial_site_evidence_keeps_map_and_known_facts(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get_stations.return_value = []
        with patch.object(site, "_build_client", return_value=client), \
             patch.object(site, "_resolve_station", AsyncMock(return_value=SimpleNamespace(group_uuid="group"))), \
             patch.object(site, "_station_to_dict", return_value={"station_name": "测试站", "latitude": 30, "longitude": 120}), \
             patch.object(site, "_fetch_terrain", AsyncMock(return_value=({"slope_degrees": 12}, None))), \
             patch.object(site, "_fetch_geology", AsyncMock(return_value=(None, "该位置未获得可用地质单元"))):
            message, _ = await self.run_tool(site.inspect_site_environment, {"station_name_or_uuid": "测试站"})
        self.assertEqual(message.status, "error")
        self.assertEqual(message.artifact["site_environment"]["terrain"]["slope_degrees"], 12)
        self.assertIn("资料不完整", message.artifact["data"]["message"])
        self.assertIn("slope_degrees", message.content)

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
        self.assertEqual(len(message.artifact["chart_points"]), 5)
        self.assertEqual(message.artifact["data"]["station_name"], "测试站")
        self.assertIn("未配置", message.artifact["data"]["message"])
        self.assertNotIn("VISION_", message.content)
        self.assertNotIn("TEST_IMAGE", str(convert_to_openai_messages([message])))

    async def test_success_artifact_not_serialized_to_model(self):
        @tool(response_format="content_and_artifact")
        def evidence():
            """测试模型事实与展示序列分离。"""
            return tool_result({"station_name": "测试站", "net_change_mm": 2},
                artifact={"chart_points": [{"t": "DISPLAY_ONLY", "n": 1}]}, display={"station_name": "测试站"})
        message, _ = await self.run_tool(evidence, {})
        self.assertEqual(message.status, "success")
        self.assertEqual(message.artifact["chart_points"][0]["t"], "DISPLAY_ONLY")
        self.assertNotIn("DISPLAY_ONLY", str(convert_to_openai_messages([message])))
        self.assertIn("net_change_mm", message.content)
