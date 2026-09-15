import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage

from app.agent import context


def _settings(**overrides):
    values = {
        "context_token_threshold": 400,
        "context_model_context": 1_000,
        "context_compress_ratio": 0.8,
        "context_target_ratio": 0.5,
        "context_output_reserve_tokens": 0,
        "context_safety_margin_tokens": 0,
        "context_token_estimate_factor": 1.0,
        "context_chars_per_token": 1.0,
        "context_min_turns": 2,
        "llm_model": "test-model",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _turn(index: int, payload: str = ""):
    call_id = f"call-{index}"
    return [
        HumanMessage(id=f"human-{index}", content=f"第 {index} 轮查询"),
        AIMessage(
            id=f"tool-request-{index}",
            content="",
            tool_calls=[{"id": call_id, "name": "get_daily_gnss_data", "args": {}}],
        ),
        ToolMessage(
            id=f"tool-result-{index}",
            tool_call_id=call_id,
            name="get_daily_gnss_data",
            content=payload or '{"points": []}',
        ),
        AIMessage(id=f"answer-{index}", content=f"第 {index} 轮回答"),
    ]


class ContextManagementTests(unittest.IsolatedAsyncioTestCase):
    async def test_below_threshold_keeps_messages_untouched(self):
        messages = _turn(1)
        with patch.object(
            context,
            "get_settings",
            return_value=_settings(context_token_threshold=100_000, context_model_context=200_000),
        ):
            self.assertEqual(await context.manage_context(messages, ""), {})
        self.assertEqual(len(messages), 4)

    async def test_compression_evicts_whole_oldest_turns_and_keeps_recent_turns(self):
        messages = []
        for index in range(1, 5):
            messages.extend(_turn(index, "x" * 500))

        with (
            patch.object(context, "get_settings", return_value=_settings()),
            patch.object(context, "compress_history", AsyncMock(return_value="压缩摘要")),
        ):
            update = await context.manage_context(messages, "")

        removed = {message.id for message in update["messages"]}
        self.assertTrue(all(isinstance(message, RemoveMessage) for message in update["messages"]))
        self.assertEqual(removed, {message.id for message in messages[:8]})
        self.assertFalse(removed & {message.id for message in messages[-8:]})
        self.assertEqual(update["context_summary"], "压缩摘要")

    async def test_compression_failure_preserves_checkpoint_messages(self):
        messages = _turn(1, "x" * 500) + _turn(2, "x" * 500) + _turn(3, "x" * 500)
        with (
            patch.object(context, "get_settings", return_value=_settings()),
            patch.object(context, "compress_history", AsyncMock(side_effect=RuntimeError("failed"))),
        ):
            with self.assertLogs(context.logger, level="WARNING"):
                self.assertEqual(await context.manage_context(messages, ""), {})

    def test_turn_split_and_evictable_text_keep_message_protocol_intact(self):
        messages = _turn(1) + _turn(2)
        self.assertEqual([len(turn) for turn in context.split_turns(messages)], [4, 4])
        self.assertIsNone(context._evictable_text(messages[2]))
        self.assertIsNone(context._evictable_text(messages[1]))
        self.assertIn("用户", context._evictable_text(messages[0]) or "")
        self.assertIn("助手", context._evictable_text(messages[3]) or "")


if __name__ == "__main__":
    unittest.main()
