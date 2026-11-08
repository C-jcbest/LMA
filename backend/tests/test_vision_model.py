"""验证视觉模型通过官方集成发送图片，并解析两种协议的结构化输出。"""

import json
import unittest
from functools import partial
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent import vision
from app.agent.models import create_chat_model
from app.agent.prompting import VISION_PROMPT
from app.config import Settings


class VisionModelTests(unittest.IsolatedAsyncioTestCase):
    async def invoke_model(self, protocol, model_name, response_body):
        requests = []

        def handle_request(request):
            requests.append(request)
            return httpx.Response(200, json=response_body)

        settings = SimpleNamespace(
            vision_provider="openai",
            vision_protocol=protocol,
            vision_model=model_name,
            vision_api_key="INVALID_TEST_KEY",
            vision_base_url="https://test.invalid/v1",
            vision_thinking=False,
        )
        messages = [
            SystemMessage(content=VISION_PROMPT),
            HumanMessage(content=[
                {"type": "text", "text": "请观察测试图表并返回 JSON。"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,TEST_IMAGE"},
                },
            ]),
        ]
        vision._get_vision_llm.cache_clear()
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle_request)) as client:
                with patch.object(vision, "get_settings", return_value=settings), patch.object(
                    vision,
                    "create_chat_model",
                    new=partial(create_chat_model, http_async_client=client),
                ):
                    model = vision._get_vision_llm()
                result = await model.with_structured_output(
                    vision.VisionObservations, method="json_mode", include_raw=True
                ).ainvoke(messages, config={"callbacks": []})
        finally:
            vision._get_vision_llm.cache_clear()
        self.assertEqual(len(requests), 1)
        self.assertIsNone(result["parsing_error"])
        self.assertIsInstance(result["parsed"], vision.VisionObservations)
        return requests[0], result

    async def test_responses_sends_image_and_parses_text_after_reasoning(self):
        observations = {"trends": ["北向缓慢变化"], "fact_text": "测试曲线平滑。"}
        response_body = {
            "id": "resp_vision_test",
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "error": None,
            "model": "gpt-6-luna",
            "output": [
                {
                    "id": "rs_vision_test",
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "测试思考摘要。"}],
                },
                {
                    "id": "msg_vision_test",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": json.dumps(observations, ensure_ascii=False),
                        "annotations": [],
                    }],
                },
            ],
            "usage": {
                "input_tokens": 100,
                "output_tokens": 40,
                "total_tokens": 140,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 10},
            },
        }
        request, result = await self.invoke_model(
            "responses", "gpt-6-luna", response_body
        )
        payload = json.loads(request.content)
        self.assertEqual(request.url.path, "/v1/responses")
        self.assertEqual(payload["text"]["format"], {"type": "json_object"})
        self.assertEqual(payload["max_output_tokens"], 8000)
        self.assertNotIn("messages", payload)
        self.assertNotIn("extra_body", payload)
        self.assertNotIn("enable_thinking", payload)
        image = payload["input"][-1]["content"][-1]
        self.assertEqual(image["type"], "input_image")
        self.assertEqual(image["image_url"], "data:image/png;base64,TEST_IMAGE")
        self.assertEqual(result["parsed"].trends, observations["trends"])
        self.assertEqual(result["parsed"].fact_text, observations["fact_text"])
        self.assertEqual(result["raw"].usage_metadata["total_tokens"], 140)

    async def test_explicit_chat_completions_sends_qwen_thinking_option(self):
        self.assertEqual(Settings.model_fields["vision_protocol"].default, "chat_completions")
        observations = {"trends": ["东向平稳"]}
        response_body = {
            "id": "chatcmpl_vision_test",
            "object": "chat.completion",
            "created": 1,
            "model": "qwen3.7-plus",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": json.dumps(observations, ensure_ascii=False),
                },
                "finish_reason": "stop",
            }],
        }
        request, result = await self.invoke_model(
            "chat_completions", "qwen3.7-plus", response_body
        )
        payload = json.loads(request.content)
        self.assertEqual(request.url.path, "/v1/chat/completions")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["max_completion_tokens"], 8000)
        self.assertIs(payload["enable_thinking"], False)
        self.assertNotIn("input", payload)
        image = payload["messages"][-1]["content"][-1]
        self.assertEqual(image["type"], "image_url")
        self.assertEqual(image["image_url"]["url"], "data:image/png;base64,TEST_IMAGE")
        self.assertEqual(result["parsed"].trends, observations["trends"])


if __name__ == "__main__":
    unittest.main()
