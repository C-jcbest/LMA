"""隐藏上下文和推理只留在内部；实时消息与历史共用公开投影。"""

import json
import unittest
from datetime import datetime
from unittest.mock import patch

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

from app.agent import message_context
from app.server.messages import project_message, project_state


class MessageProjectionTests(unittest.TestCase):
    def test_resume_context_is_stable_model_only_metadata(self):
        message = HumanMessage(id='resume', content='继续调查', additional_kwargs={
            'lma_resume_investigation_id': '44444444-4444-4444-4444-444444444444',
        })
        stamped = message_context.stamp_user_message(message)
        first = message_context.model_messages([stamped])[0]
        second = message_context.model_messages([stamped])[0]
        self.assertEqual(first.content, second.content)
        self.assertIn('44444444-4444-4444-4444-444444444444', first.content)
        public = project_message(stamped)
        self.assertEqual(public['content'], '继续调查')
        self.assertNotIn('44444444', json.dumps(public))

    def test_visible_evidence_matches_model_marker_without_mutating_checkpoint(self):
        message = ToolMessage(content="监测结果", tool_call_id="query-1", artifact={"version": 1, "kind": "gnss_series", "data": {}})
        public = project_message(message)
        identifier = public["artifact"]["evidence_id"]
        self.assertIn(identifier, message_context.model_messages([message])[0].content)
        self.assertNotIn("evidence_id", message.artifact)
        message.status = "error"
        self.assertNotIn("evidence_id", project_message(message)["artifact"])

    def test_time_snapshot_is_immutable_and_never_changes_user_body(self):
        original = HumanMessage(id="question", content="今天如何？")
        now = datetime.fromisoformat("2026-11-09T12:30:00+08:00")
        with patch.object(message_context, "business_now", return_value=now) as clock:
            stamped = message_context.stamp_user_message(original)
            self.assertIs(message_context.stamp_user_message(stamped), stamped)
        clock.assert_called_once()
        self.assertEqual(stamped.content, original.content)
        projected = message_context.model_messages([stamped])[0]
        self.assertIn(now.isoformat(), projected.content)
        self.assertIn("timezone: Asia/Shanghai", projected.content)
        self.assertEqual(projected.id, original.id)
        public = project_message(stamped)
        self.assertEqual(public["content"], original.content)
        self.assertNotIn("lma_context", json.dumps(public))
        self.assertNotIn("sent_at", json.dumps(public))

    def test_multimodal_content_is_preserved_in_model_projection(self):
        content = [{"type": "text", "text": "查看图片"},
                   {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}]
        stamped = message_context.stamp_user_message(HumanMessage(content=content))
        projected = message_context.model_messages([stamped])[0]
        self.assertEqual(projected.content[1:], content)
        self.assertEqual(stamped.content, content)

    def test_reasoning_filtered_from_stream_and_history_without_mutating_internal_message(self):
        for message_class in [AIMessage, AIMessageChunk]:
            with self.subTest(message_class=message_class):
                message = message_class(
                    content=[{"type": "reasoning", "reasoning": "PRIVATE_CHAIN"},
                             {"type": "text", "text": "公开回答"}],
                    additional_kwargs={"reasoning_content": "PRIVATE_PROVIDER",
                                       "thinking": "PRIVATE_THINKING",
                                       "lc_source": "summarization"},
                    response_metadata={"reasoning": "PRIVATE_RESPONSE", "model_name": "test"},
                    tool_calls=[{"name": "station", "args": {}, "id": "call-1"}],
                    usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                )
                stream_message = project_message(message)
                history_message = project_state({"messages": [message]})["messages"][0]
                for public in [stream_message, history_message]:
                    self.assertNotIn("PRIVATE_", json.dumps(public))
                    self.assertIn({"type": "text", "text": "公开回答"}, public["content"])
                    self.assertEqual(public["tool_calls"][0]["id"], "call-1")
                    self.assertEqual(public["usage_metadata"]["input_tokens"], 10)
                    self.assertEqual(public["additional_kwargs"]["metadata"]["lc_source"], "summarization")
                self.assertEqual(message.additional_kwargs["reasoning_content"], "PRIVATE_PROVIDER")
                self.assertNotIn("recommendations", json.dumps(history_message))

    def test_unknown_provider_fields_are_not_public(self):
        message = AIMessage(
            content=[{"type": "text", "text": "公开回答"},
                     {"type": "future_trace", "trace": "PRIVATE_BLOCK"}],
            additional_kwargs={"future_provider_trace": "PRIVATE_KWARG"},
            response_metadata={"future_trace": "PRIVATE_METADATA", "finish_reason": "stop"},
        )
        public = project_message(message)
        self.assertNotIn("PRIVATE_", json.dumps(public))
        self.assertEqual(public["response_metadata"]["finish_reason"], "stop")
