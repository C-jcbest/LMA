import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from openai import APIConnectionError, APIStatusError
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.agent.tool_protocol import ToolFailure
from app.agent.tool_inputs import GnssInput
from pydantic import ValidationError
from app.agent import context, graph, models, retry, site, summarization, title, tools, vision, weather
from app.agent.prompting import SYSTEM_PROMPT, VISION_PROMPT
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

    def test_thinking_options_map_provider_specific_params(self):
        # DeepSeek Chat Completions
        self.assertEqual(
            models.thinking_options("deepseek", True),
            {"extra_body": {"thinking": {"type": "enabled"}}},
        )
        self.assertEqual(
            models.thinking_options("deepseek", False),
            {"extra_body": {"thinking": {"type": "disabled"}}},
        )
        # OpenAI Responses API
        self.assertEqual(
            models.thinking_options("openai", True, protocol="responses", vendor="openai"),
            {
                "use_responses_api": True,
                "output_version": "responses/v1",
                "reasoning": {
                    "effort": "medium",
                    "summary": "auto",
                },
            },
        )
        self.assertEqual(
            models.thinking_options("openai", False, protocol="responses", vendor="openai"),
            {
                "use_responses_api": True,
                "output_version": "responses/v1",
                "reasoning": None,
            },
        )
        # DashScope Responses API (按百炼规范 effort=none)
        self.assertEqual(
            models.thinking_options("openai", True, protocol="responses", vendor="dashscope"),
            {
                "use_responses_api": True,
                "output_version": "responses/v1",
                "reasoning": {
                    "effort": "medium",
                    "summary": "auto",
                },
            },
        )
        self.assertEqual(
            models.thinking_options("openai", False, protocol="responses", vendor="dashscope"),
            {
                "use_responses_api": True,
                "output_version": "responses/v1",
                "reasoning": {"effort": "none"},
            },
        )
        # DashScope Chat Completions (Qwen hybrid thinking extra_body.enable_thinking)
        self.assertEqual(
            models.thinking_options("openai", True, protocol="chat_completions", vendor="dashscope"),
            {"extra_body": {"enable_thinking": True}},
        )
        self.assertEqual(
            models.thinking_options("openai", False, protocol="chat_completions", vendor="dashscope"),
            {"extra_body": {"enable_thinking": False}},
        )
        # OpenAI Chat Completions (standard)
        self.assertEqual(
            models.thinking_options("openai", False, protocol="chat_completions", vendor="openai"),
            {},
        )
        with self.assertRaises(ValueError):
            models.thinking_options("qwen", False)
        with self.assertRaises(ValueError):
            models.thinking_options("openai", False, protocol="invalid_protocol")
        with self.assertRaises(ValueError):
            models.thinking_options("deepseek", True, protocol="responses")


    def test_openai_provider_uses_official_init_chat_model(self):
        constructed = SimpleNamespace(profile={"tool_calling": True})
        with patch.object(models, "init_chat_model", return_value=constructed) as init_model:
            result = models.create_chat_model(
                provider="openai",
                model="test-model",
                api_key="test-key",
                base_url="https://example.invalid/v1",
                thinking=False,
                tool_loop=True,
                temperature=0,
            )
        self.assertIs(result, constructed)
        init_model.assert_called_once_with(
            model="test-model",
            model_provider="openai",
            api_key="test-key",
            base_url="https://example.invalid/v1",
            temperature=0,
            max_retries=0,
            use_responses_api=True,
            output_version="responses/v1",
            reasoning=None,
        )

    def test_configured_profile_only_fills_missing_official_fields(self):
        official = SimpleNamespace(
            profile={"max_input_tokens": 128_000, "tool_calling": True}
        )
        with patch.object(models, "init_chat_model", return_value=official):
            result = models.create_chat_model(
                provider="openai",
                model="gpt-4o-mini",
                api_key="test-key",
                base_url="https://api.openai.com/v1",
                thinking=False,
                profile={"max_input_tokens": 1_048_576},
            )
        self.assertEqual(
            result.profile,
            {"max_input_tokens": 128_000, "tool_calling": True},
        )

        custom = SimpleNamespace(profile=None)
        with patch.object(models, "init_chat_model", return_value=custom):
            result = models.create_chat_model(
                provider="deepseek",
                model="custom-model",
                api_key="test-key",
                base_url="https://example.invalid/v1",
                thinking=False,
                profile={"max_input_tokens": 1_048_576},
            )
        self.assertEqual(result.profile, {"max_input_tokens": 1_048_576})

    def test_deepseek_maps_vision_output_budget_to_max_tokens(self):
        with patch.object(models, "init_chat_model") as init_model:
            init_model.return_value.profile = {}
            models.create_chat_model(
                provider="deepseek",
                model="vision-model",
                api_key="test-key",
                base_url="https://example.invalid/v1",
                thinking=True,
                tool_loop=False,
                max_completion_tokens=8000,
            )
        kwargs = init_model.call_args.kwargs
        self.assertEqual(kwargs["max_tokens"], 8000)
        self.assertNotIn("max_completion_tokens", kwargs)

    def test_auxiliary_models_do_not_inherit_main_thinking(self):
        settings = SimpleNamespace(
            llm_provider="deepseek",
            llm_model="test-model",
            llm_api_key="test-key",
            llm_base_url="https://example.invalid/v1",
            llm_thinking=True,
            title_thinking=False,
            recommend_enabled=True,
            recommend_thinking=False,
            context_summary_max_tokens=2000,
            compress_thinking=False,
            vision_provider="deepseek",
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
                # DeepSeek 关闭思考必须显式 disabled，不能只靠“不传参数”。
                self.assertEqual(llm.extra_body, {"thinking": {"type": "disabled"}})
        finally:
            for _, factory in factories:
                factory.cache_clear()

    def test_all_five_roles_read_independent_thinking_settings(self):
        settings = SimpleNamespace(
            llm_provider="deepseek",
            llm_model="test-model",
            llm_api_key="test-key",
            llm_base_url="https://example.invalid/v1",
            llm_thinking=False,
            context_model_context=1_048_576,
            title_thinking=True,
            recommend_enabled=True,
            recommend_thinking=True,
            context_summary_max_tokens=2000,
            compress_thinking=True,
            vision_provider="deepseek",
            vision_model="vision-model",
            vision_api_key="test-key",
            vision_base_url="https://example.invalid/v1",
            vision_thinking=True,
        )
        factories = (
            (graph, graph._get_llm, {"thinking": {"type": "disabled"}}),
            (title, title._get_title_llm, {"thinking": {"type": "enabled"}}),
            (graph, graph._get_recommend_llm, {"thinking": {"type": "enabled"}}),
            (summarization, summarization._get_summary_model, {"thinking": {"type": "enabled"}}),
            (vision, vision._get_vision_llm, {"thinking": {"type": "enabled"}}),
        )
        try:
            for module, factory, expected_extra_body in factories:
                factory.cache_clear()
                with patch.object(module, "get_settings", return_value=settings):
                    llm = factory()
                self.assertEqual(llm.extra_body, expected_extra_body)
        finally:
            for module, factory, _ in factories:
                factory.cache_clear()

    def test_deepseek_thinking_adapter_writes_back_reasoning_content(self):
        llm = models.DeepSeekThinkingChatModel(
            model="deepseek-flash",
            api_key="test-key",
            base_url="https://example.invalid/v1",
        )
        message = AIMessage(
            content="",
            additional_kwargs={"reasoning_content": "先核对数据。"},
            tool_calls=[{"id": "call-1", "name": "list_stations", "args": {}}],
        )
        tool_result = ToolMessage(content="完成", tool_call_id="call-1")
        payload = llm._get_request_payload(
            [HumanMessage(content="查询"), message, tool_result]
        )
        assistant = next(item for item in payload["messages"] if item["role"] == "assistant")
        self.assertEqual(assistant["reasoning_content"], "先核对数据。")
        human = next(item for item in payload["messages"] if item["role"] == "user")
        self.assertNotIn("reasoning_content", human)

    def test_tool_calling_profile_only_explicit_false_is_rejected(self):
        models.assert_tool_calling(SimpleNamespace(profile={"tool_calling": True}))
        models.assert_tool_calling(SimpleNamespace(profile={}))
        models.assert_tool_calling(SimpleNamespace(profile=None))
        with self.assertRaisesRegex(ValueError, "不支持 tool calling"):
            models.assert_tool_calling(
                SimpleNamespace(profile={"tool_calling": False}, model="no-tools")
            )

    def test_deepseek_adapter_only_used_for_main_tool_loop_with_thinking(self):
        # 1. 主 Agent + DeepSeek + thinking=True + tool_loop=True -> DeepSeekThinkingChatModel
        with patch.object(models, "DeepSeekThinkingChatModel") as ds_adapter, \
             patch.object(models, "init_chat_model") as init_model:
            ds_adapter.return_value.profile = {"tool_calling": True}
            result = models.create_chat_model(
                provider="deepseek",
                model="deepseek-chat",
                api_key="key",
                base_url="https://api.deepseek.com",
                thinking=True,
                tool_loop=True,
            )
            self.assertIs(result, ds_adapter.return_value)
            ds_adapter.assert_called_once()
            init_model.assert_not_called()

        # 2. 主 Agent + DeepSeek + thinking=False + tool_loop=True -> 官方 init_chat_model
        with patch.object(models, "init_chat_model") as init_model, \
             patch.object(models, "DeepSeekThinkingChatModel") as ds_adapter:
            init_model.return_value.profile = {"tool_calling": True}
            result = models.create_chat_model(
                provider="deepseek",
                model="deepseek-chat",
                api_key="key",
                base_url="https://api.deepseek.com",
                thinking=False,
                tool_loop=True,
            )
            self.assertIs(result, init_model.return_value)
            ds_adapter.assert_not_called()

        # 3. 辅助角色 (tool_loop=False) + DeepSeek + thinking=True -> 官方 init_chat_model
        with patch.object(models, "init_chat_model") as init_model, \
             patch.object(models, "DeepSeekThinkingChatModel") as ds_adapter:
            init_model.return_value.profile = {}
            result = models.create_chat_model(
                provider="deepseek",
                model="deepseek-chat",
                api_key="key",
                base_url="https://api.deepseek.com",
                thinking=True,
                tool_loop=False,
            )
            self.assertIs(result, init_model.return_value)
            ds_adapter.assert_not_called()

    def test_assert_requested_reasoning_profile_validation(self):
        with self.assertRaisesRegex(ValueError, "明确不支持 reasoning"):
            models.assert_requested_reasoning(
                SimpleNamespace(profile={"reasoning_output": False}, model="plain-model"),
                enabled=True,
            )
        models.assert_requested_reasoning(
            SimpleNamespace(profile={"reasoning_output": False}, model="plain-model"),
            enabled=False,
        )
        models.assert_requested_reasoning(SimpleNamespace(profile=None), enabled=True)
        models.assert_requested_reasoning(SimpleNamespace(profile={}), enabled=True)

    def test_formal_prompt_files_are_the_only_sources(self):
        repo_root = Path(__file__).resolve().parents[2]
        prompt_dir = repo_root / "backend" / "app" / "agent" / "prompts"
        self.assertEqual(SYSTEM_PROMPT, (prompt_dir / "system.md").read_text(encoding="utf-8"))
        self.assertEqual(VISION_PROMPT, (prompt_dir / "vision.md").read_text(encoding="utf-8"))
        self.assertFalse((repo_root / "prompt.md").exists())
        self.assertNotIn("{{CURRENT_TIME}}", SYSTEM_PROMPT)

    def test_clock_is_aware(self):
        self.assertEqual(business_now().utcoffset(), timedelta(hours=8))

    def test_get_current_time_returns_server_time_and_timezone(self):
        now = datetime(2026, 9, 14, 15, 30, 0, tzinfo=BUSINESS_TZ)
        with patch.object(tools, "business_now", return_value=now):
            content, artifact = tools.get_current_time.func()
            message = tools.get_current_time.invoke(
                {"name": "get_current_time", "args": {}, "id": "call-1", "type": "tool_call"}
            )
        data = json.loads(content)
        self.assertEqual(data["current_time"], "2026-09-14 15:30:00")
        self.assertEqual(data["timezone"], "Asia/Shanghai")
        self.assertEqual(artifact["data"], data)
        self.assertEqual(message.artifact["data"], data)

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
        for status, expected in ((408, True), (429, True), (500, True), (502, True), (503, True), (504, True), (400, False), (401, False), (403, False), (404, False), (501, False), (505, False)):
            error = APIStatusError("test error", response=httpx.Response(status, request=request), body=None)
            self.assertEqual(retry.is_transient_error(error), expected)

    def test_mixed_exception_group_is_not_retried(self):
        self.assertFalse(retry.is_transient_error(ExceptionGroup("mixed", [TimeoutError(), ValueError()])))
        self.assertTrue(retry.is_transient_error(ExceptionGroup("network", [TimeoutError(), ConnectionError()])))
        self.assertTrue(retry.is_transient_error(httpx.RemoteProtocolError("server disconnected")))
        self.assertFalse(retry.is_transient_error(httpx.LocalProtocolError("invalid request")))

    def test_context_usage_uses_only_provider_usage_and_model_profile_limit(self):
        snapshot = context.build_context_usage(
            {"input_tokens": 321, "output_tokens": 20, "total_tokens": 341},
            max_input_tokens=100_000,
            model="deepseek-flash",
        )
        self.assertEqual(snapshot["input_tokens"], 321)
        self.assertEqual(snapshot["output_tokens"], 20)
        self.assertEqual(snapshot["total_tokens"], 341)
        self.assertEqual(snapshot["max_input_tokens"], 100_000)
        self.assertEqual(snapshot["usage_ratio"], 321 / 100_000)
        self.assertEqual(snapshot["model"], "deepseek-flash")

    def test_model_profile_limit_validation(self):
        self.assertEqual(
            models.model_max_input_tokens(
                SimpleNamespace(profile={"max_input_tokens": 128_000})
            ),
            128_000,
        )
        for profile in (None, {}, {"max_input_tokens": 0}, {"max_input_tokens": True}):
            with self.subTest(profile=profile):
                self.assertIsNone(models.model_max_input_tokens(SimpleNamespace(profile=profile)))

        with self.assertRaisesRegex(ValueError, "input_tokens"):
            context.build_context_usage({}, max_input_tokens=100_000, model="test")

    def test_recommendations_require_strict_json_and_allow_model_to_decline(self):
        self.assertEqual(
            graph._validate_recommendations(["查看近期趋势", "对比同组测点"]),
            ["查看近期趋势", "对比同组测点"],
        )
        self.assertEqual(graph._validate_recommendations([]), [])
        with self.assertRaises(ValueError):
            graph._validate_recommendations(["单个建议"])
        with self.assertRaises(ValueError):
            graph._validate_recommendations(["建议" * 31, "正常建议"])

    def test_responses_api_reasoning_and_text_content_blocks_text_extraction(self):
        """Responses API: BaseMessage.text 只取得最终文本，忽略 reasoning 块；禁止 str(content)。"""
        msg = AIMessage(content=[
            {"type": "reasoning", "reasoning": "思考：分析数据变化情况"},
            {"type": "text", "text": "最终回答文本内容"}
        ])
        # 1. BaseMessage.text 必须返回纯文本，忽略思考过程
        self.assertEqual(msg.text, "最终回答文本内容")
        # 2. graph._message_text 提取纯文本
        self.assertEqual(graph._message_text(msg), "最终回答文本内容")
        # 3. 验证如果使用 str(msg.content) 会带有 Python 字典 repr，确认必须禁止此类逻辑
        self.assertIn("'type': 'reasoning'", str(msg.content))
        self.assertNotEqual(str(msg.content), "最终回答文本内容")

    def test_vision_json_object_structured_output_with_content_blocks(self):
        """Vision: Content Blocks (reasoning + text) 验证结构化输出与 Pydantic 校验。"""
        valid_json = json.dumps({
            "trends": ["N向平稳"],
            "turning_points": [],
            "readings": [],
            "candidates": [
                {"metric": "N", "start_at": "2026-09-01 01:00:00", "end_at": "2026-09-01 02:00:00", "description": "正常候选"}
            ],
            "interpretation": ["疑似微小扰动"],
            "image_quality": "清晰",
            "fact_text": "事实描述",
            "limitations": []
        })
        msg = AIMessage(content=[
            {"type": "reasoning", "reasoning": "视觉模型内部思考过程"},
            {"type": "text", "text": valid_json}
        ])
        from langchain_core.output_parsers import PydanticOutputParser
        parser = PydanticOutputParser(pydantic_object=vision.VisionObservations)
        parsed = parser.parse(msg.text)
        self.assertIsInstance(parsed, vision.VisionObservations)
        self.assertEqual(parsed.trends, ["N向平稳"])
        self.assertEqual(len(parsed.candidates), 1)

        validated = vision._validate_observations(parsed, datetime(2026, 9, 1), datetime(2026, 9, 2))
        self.assertIsInstance(validated, vision.VisionObservations)
        self.assertEqual(len(validated.candidates), 1)

    def test_recommendation_json_schema_validation(self):
        """Recommendation: RecommendationResult JSON schema 与业务校验。"""
        res = graph.RecommendationResult(recommendations=["建议一", "建议二"])
        self.assertEqual(graph._validate_recommendations(res.recommendations), ["建议一", "建议二"])
        with self.assertRaises(ValueError):
            graph._validate_recommendations(["只有一条建议"])
        with self.assertRaises(ValueError):
            graph._validate_recommendations(["一", "二", "三", "四"])
        with self.assertRaises(ValueError):
            graph._validate_recommendations(["长" * 61, "正常建议"])

    def test_vision_thinking_false_carries_enable_thinking_false(self):
        """VISION_THINKING=false 时确认构造请求真正携带 enable_thinking=false。"""
        with patch.object(models, "init_chat_model") as mock_init:
            mock_init.return_value.profile = {}
            models.create_chat_model(
                provider="openai",
                model="qwen3.7-plus",
                api_key="mock",
                base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
                thinking=False,
                protocol="chat_completions",
            )
            mock_init.assert_called_once()
            kwargs = mock_init.call_args.kwargs
            self.assertEqual(kwargs.get("extra_body"), {"enable_thinking": False})
            self.assertNotIn("use_responses_api", kwargs)

    def test_title_uses_response_text_with_content_blocks(self):
        """Title: 验证 title 节点从 content blocks 正确通过 response.text 提取标题。"""
        msg = AIMessage(content=[
            {"type": "reasoning", "reasoning": "提炼标题思考过程"},
            {"type": "text", "text": "SCWM-04监测点数据分析"}
        ])
        self.assertEqual(title.clean_generated_title(msg.text), "SCWM-04监测点数据分析")


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
    async def test_get_current_time_async_tool_call(self):
        now = datetime(2026, 9, 14, 15, 30, 0, tzinfo=BUSINESS_TZ)
        with patch.object(tools, "business_now", return_value=now):
            content = await tools.get_current_time.ainvoke({})
        data = json.loads(content)
        self.assertEqual(data["current_time"], "2026-09-14 15:30:00")
        self.assertEqual(data["timezone"], "Asia/Shanghai")

    async def test_disabled_recommendations_skip_model_call(self):
        state = {
            "messages": [HumanMessage(content="查询站点"), AIMessage(content="查询完成")],
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
            message = await site.inspect_site_environment.ainvoke({
                "type": "tool_call",
                "id": "site-call",
                "name": "inspect_site_environment",
                "args": {"station_name_or_uuid": "ZJ-MS10"},
            })
        self.assertTrue(json.loads(message.content)["ok"])
        environment = message.artifact["data"]
        self.assertEqual(environment["version"], 1)
        self.assertEqual(environment["coordinate_system"], "WGS84")
        self.assertEqual(environment["center_station"]["station_name"], "ZJ-MS10")
        self.assertEqual(environment["terrain"]["dem_elevation_m"], terrain["dem_elevation_m"])
        self.assertEqual(environment["terrain"]["slope_degrees"], terrain["slope_degrees"])
        self.assertEqual(environment["geology"]["name"], geology["name"])
        self.assertEqual(environment["geology"]["lithology"], geology["lithology"])

    async def test_invalid_title_is_reported_instead_of_fabricated(self):
        with self.assertRaises(ValueError):
            await title.generate_title_node({"input_text": "   ", "title": ""})

    async def test_weather_default_window_uses_business_day(self):
        now = datetime(2026, 9, 14, 0, 5, tzinfo=BUSINESS_TZ)
        fetch = AsyncMock(return_value={"current": {"temperature_2m": 20}})
        with patch.object(weather, "business_now", return_value=now), patch.object(weather, "_fetch_json", fetch):
            result = json.loads(await weather.query_weather.ainvoke({"latitude": 30, "longitude": 120}))
        self.assertEqual(result["query"]["history_end_date"], "2026-09-13")
        self.assertEqual(result["query"]["history_start_date"], "2026-09-07")
        self.assertTrue(all(c.args[1]["timezone"] == "Asia/Shanghai" for c in fetch.call_args_list))
        self.assertIsNone(result["rain_summary"]["recent_24h_precipitation"])

    async def test_weather_day_limits(self):
        now = datetime(2026, 9, 15, 12, 0, tzinfo=BUSINESS_TZ)
        with patch.object(weather, "business_now", return_value=now):
            with self.assertRaisesRegex(ToolFailure, "历史天气最多只能查询到昨天"):
                await weather.query_weather.ainvoke({
                    "latitude": 30, "longitude": 120,
                    "start_date": "2026-09-10", "end_date": "2026-09-15"
                })

    async def test_base_station_does_not_query_deformation(self):
        for module, tool in ((tools, tools.get_daily_gnss_data), (vision, vision.analyze_gnss_chart)):
            client = AsyncMock()
            client.__aenter__.return_value = client
            with patch.object(module, "_build_client", return_value=client), patch.object(module, "_resolve_station", AsyncMock(return_value=SimpleNamespace(station_type=1))):
                with self.assertRaisesRegex(ToolFailure, "基准站"):
                    args = {
                        "station_name_or_uuid": "基准站",
                        "begin_time": "2026-09-01 00:00:00",
                        "end_time": "2026-09-14 00:00:00",
                    }
                    if tool is vision.analyze_gnss_chart:
                        await tool.ainvoke({
                            "type": "tool_call",
                            "id": "vision-call",
                            "name": "analyze_gnss_chart",
                            "args": args,
                        })
                    else:
                        await tool.ainvoke(args)
            client.get_daily_data.assert_not_called()

    async def test_invalid_sampling_frequency_is_not_silently_replaced(self):
        with self.assertRaises(ValidationError):
            GnssInput.model_validate({"station_name_or_uuid": "测试站", "begin_time": "2026-09-01 00:00:00",
                "end_time": "2026-09-02 00:00:00", "sampling_frequency": "sometimes"})


if __name__ == "__main__":
    unittest.main()
