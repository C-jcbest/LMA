"""生产官方摘要的长对话、消息配对与失败路径回归。"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.checkpoint.memory import InMemorySaver
from app.agent import context, graph, summarization
from runtime_fixtures import ScriptedModel


def turn(index):
    return [HumanMessage(id=f"u{index}", content=f"站点甲 第{index}轮 2026-09-15 Asia/Shanghai"),
        AIMessage(id=f"a{index}", content="", tool_calls=[{"id": f"c{index}", "name": "query", "args": {}}]),
        ToolMessage(id=f"t{index}", content="缺测；视觉候选尚未确认；" + "x" * 20000,
                    tool_call_id=f"c{index}", name="query"),
        AIMessage(id=f"f{index}", content="证据有限，不能判断滑坡")]


class ContextManagementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(recommend_enabled=False, llm_model="test", context_token_threshold=10000,
            context_model_context=100000, context_keep_tokens=1000,
            context_summary_max_tokens=2000, context_output_reserve_tokens=100,
            context_safety_margin_tokens=20, context_token_estimate_factor=1.0, context_chars_per_token=1.6667)
        for module in (context, graph, summarization):
            patcher = patch.object(module, "get_settings", return_value=settings)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.config = {"configurable": {"thread_id": "summary-test"}}
        self.summary = ScriptedModel(tags=["nostream"], script=[AIMessage(content=
            "站点甲；2026-09-15 Asia/Shanghai；缺测，视觉候选未确认，不能推定气象因果。") for _ in range(3)])
        self.model = ScriptedModel(script=[AIMessage(content="继续核实") for _ in range(3)])

    def build(self):
        return graph.create_lma_agent(self.model, agent_tools=[], summary_model=self.summary,
                                      checkpointer=InMemorySaver())

    async def test_summary_persists_and_preserves_recent_token_budget(self):
        agent = self.build()
        history = turn(1) + turn(2) + turn(3) + [HumanMessage(id="current", content="继续")]
        result = await agent.ainvoke({"messages": history}, self.config)
        messages = result["messages"]
        self.assertEqual(messages[0].additional_kwargs["lc_source"], "summarization")
        self.assertNotIn("context_summary", result)
        self.assertEqual(messages[-2].id, "current")
        self.assertLessEqual(count_tokens_approximately(messages[1:-1]), 1000)
        self.assertLess(len(messages), len(history))
        self.assertIn("视觉候选未确认", self.model.inputs[0][1].content)
        self.assertIn("2026-09-15", self.summary.inputs[0][0].content)
        self.assertIn("缺少锚点不得推算", self.summary.inputs[0][0].content)
        next_result = await agent.ainvoke({"messages": [HumanMessage(content="同一站点呢？")]}, self.config)
        self.assertEqual(len([m for m in next_result["messages"]
            if m.additional_kwargs.get("lc_source") == "summarization"]), 1)
        self.assertIn("站点甲", str(self.model.inputs[-1]))

    async def test_below_token_threshold_does_not_summarize(self):
        result = await self.build().ainvoke({"messages": [HumanMessage(content="查询站点甲")]}, self.config)
        self.assertEqual(len(result["messages"]), 2)
        self.assertFalse(self.summary.inputs)

    async def test_summary_failure_preserves_checkpoint(self):
        self.summary.script = [ValueError("invalid summary config") for _ in range(3)]
        agent = self.build()
        history = turn(1) + turn(2) + turn(3) + [HumanMessage(content="继续")]
        with self.assertRaises(ValueError):
            await agent.ainvoke({"messages": history}, self.config)
        self.assertEqual(len((await agent.aget_state(self.config)).values["messages"]), len(history))

    async def test_stopped_parallel_tools_stay_paired_after_compression(self):
        stopped = [HumanMessage(content="上一轮"), AIMessage(content="", tool_calls=[
            {"id": "p1", "name": "query", "args": {}}, {"id": "p2", "name": "query", "args": {}}]),
            ToolMessage(content="已完成", tool_call_id="p1", name="query"),
            ToolMessage(content="由用户停止", tool_call_id="p2", name="query", status="error")]
        await self.build().ainvoke({"messages": turn(1) + turn(2) + stopped + [HumanMessage(content="继续")]}, self.config)
        pending = set()
        for message in self.model.inputs[0]:
            if message.type == "ai":
                pending.update(c["id"] for c in message.tool_calls)
            elif message.type == "tool":
                self.assertIn(message.tool_call_id, pending)
                pending.remove(message.tool_call_id)
        self.assertFalse(pending)
        self.assertEqual(len([m for m in self.model.inputs[0] if m.type == "tool"]), 2)

    async def test_summary_tokens_do_not_enter_main_message_stream(self):
        events = [event async for event in self.build().astream({
            "messages": turn(1) + turn(2) + turn(3) + [HumanMessage(content="继续")],
        }, self.config, stream_mode="messages")]
        self.assertTrue(self.summary.inputs)
        self.assertFalse(any(metadata.get("lc_source") == "summarization" for _, metadata in events))
        self.assertTrue(any(message.content == "继续核实" for message, _ in events))
