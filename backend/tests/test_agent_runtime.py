"""生产 create_agent 工厂回归；使用可控模型，不访问真实平台。"""

import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from app.agent import context, graph, summarization
from runtime_fixtures import ScriptedModel, call


class AgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = SimpleNamespace(
            recommend_enabled=False, context_token_threshold=800_000,
            context_model_context=1_048_576, context_compress_ratio=0.8,
            context_keep_messages=20, context_output_reserve_tokens=100,
            context_safety_margin_tokens=20, context_token_estimate_factor=1.0,
            context_chars_per_token=1.6667, context_min_turns=2, context_summary_max_tokens=2000, llm_model="test",
        )
        for module in (graph, context, summarization):
            patcher = patch.object(module, "get_settings", return_value=self.settings)
            patcher.start()
            self.addCleanup(patcher.stop)

        patcher = patch.object(graph, "_get_summary_model", return_value=ScriptedModel(script=[]))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_production_loop_checkpoint_metadata_usage_and_time(self):
        @tool
        def station() -> str:
            """读取站点。"""
            return "站点甲，缺测"

        model = ScriptedModel(script=[call(), AIMessage(
            content="数据缺测，不能判断",
            additional_kwargs={"reasoning_content": "核对证据"},
            usage_metadata={"input_tokens": 321, "output_tokens": 20, "total_tokens": 341},
        ), AIMessage(content="仍需补充")])
        agent = graph.create_lma_agent(model, agent_tools=[station], checkpointer=InMemorySaver(), retry_delay=0)
        config = {"configurable": {"thread_id": "production-test"}}
        first = datetime.fromisoformat("2026-09-15T10:00:00+08:00")
        second = datetime.fromisoformat("2026-09-16T11:00:00+08:00")
        with patch.object(graph, "business_now", return_value=first):
            result = await agent.ainvoke({"messages": [HumanMessage(content="今天如何？")]}, config)
        self.assertEqual([m.type for m in result["messages"]], ["human", "ai", "tool", "ai"])
        self.assertEqual(result["messages"][0].additional_kwargs["created_at"], first.isoformat())
        self.assertEqual(result["messages"][-1].additional_kwargs["reasoning_content"], "核对证据")
        self.assertGreaterEqual(result["messages"][-1].additional_kwargs["lma_thinking_duration_ms"], 0)
        self.assertEqual(result["context_usage"]["input_tokens"], 321)
        self.assertEqual(result["context_usage"]["remaining_tokens"], 1_048_576 - 321 - 120)
        self.assertEqual(model.inputs[0][0].content, model.inputs[1][0].content)
        with patch.object(graph, "business_now", return_value=second):
            result = await agent.ainvoke({"messages": [HumanMessage(content="昨天呢？")]}, config)
        self.assertEqual(len(result["messages"]), 6)
        self.assertEqual(result["business_time"], second.isoformat())
        self.assertEqual(result["context_usage"]["input_tokens"], 321)

    async def test_recommendations_generated_from_final_answer_and_cleared_each_run(self):
        self.settings.recommend_enabled = True
        model = ScriptedModel(script=[AIMessage(content="完整最终回答"), AIMessage(content="第二轮回答")])
        agent = graph.create_lma_agent(model, agent_tools=[], checkpointer=InMemorySaver())
        recommend = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(
            content='["查看近期趋势", "对比同组测点"]',
        )))
        config = {"configurable": {"thread_id": "recommend-test"}}
        with patch.object(graph, "_get_recommend_llm", return_value=recommend):
            first = await agent.ainvoke({"messages": [HumanMessage(content="查询")],
                                         "recommendations": ["旧建议"]}, config)
            self.assertEqual(first["recommendations"], ["查看近期趋势", "对比同组测点"])
            self.assertIn("完整最终回答", recommend.ainvoke.call_args.args[0][-1].content)
            self.settings.recommend_enabled = False
            second = await agent.ainvoke({"messages": [HumanMessage(content="继续")]}, config)
        self.assertEqual(second["recommendations"], [])
        self.assertEqual(recommend.ainvoke.call_count, 1)

    async def test_parallel_tool_retry_exhaustion_preserves_success_and_reports_error(self):
        attempts = {"station": 0, "weather": 0}

        @tool
        def station() -> str:
            """读取失败站点。"""
            attempts["station"] += 1
            raise TimeoutError("https://internal.invalid/?password=secret")

        @tool
        def weather() -> str:
            """读取气象。"""
            attempts["weather"] += 1
            return "成功"

        request = AIMessage(content="", tool_calls=[*call().tool_calls,
            {"id": "call-2", "name": "weather", "args": {}}])
        agent = graph.create_lma_agent(ScriptedModel(script=[request, AIMessage(content="说明数据限制")]),
                                       agent_tools=[station, weather], retry_delay=0)
        result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
        results = {m.name: m for m in result["messages"] if m.type == "tool"}
        self.assertEqual(attempts, {"station": 3, "weather": 1})
        self.assertEqual(results["station"].status, "error")
        self.assertEqual(results["weather"].status, "success")
        self.assertNotIn("secret", results["station"].content)
        self.assertNotIn("internal.invalid", results["station"].content)

    async def test_recommendation_failure_does_not_replace_final_answer(self):
        self.settings.recommend_enabled = True
        model = ScriptedModel(script=[AIMessage(content="最终回答")])
        agent = graph.create_lma_agent(model, agent_tools=[])
        recommend = SimpleNamespace(ainvoke=AsyncMock(side_effect=ValueError("invalid recommendation")))
        with patch.object(graph, "_get_recommend_llm", return_value=recommend), self.assertLogs(
            graph.logger, level="WARNING",
        ):
            result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
        self.assertEqual(result["messages"][-1].content, "最终回答")
        self.assertEqual(result["recommendations"], [])
        self.assertEqual(result["recommendations_error"], "下一步建议生成失败。")

    async def test_nontransient_tool_error_not_retried_and_interrupt_propagates(self):
        from langgraph.errors import GraphInterrupt

        for error in (ValueError("private error"), GraphInterrupt(())):
            attempts = []

            @tool
            def station() -> str:
                """读取站点。"""
                attempts.append(1)
                raise error

            agent = graph.create_lma_agent(ScriptedModel(script=[call(), AIMessage(content="完成")]),
                                           agent_tools=[station], retry_delay=0)
            result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
            self.assertEqual(len(attempts), 1)
            if isinstance(error, ValueError):
                self.assertEqual(result["messages"][2].status, "error")
                self.assertNotIn("private", result["messages"][2].content)
            else:
                self.assertFalse(any(m.type == "tool" for m in result["messages"]))

    async def test_model_retry_and_failure_preserve_user_checkpoint(self):
        model = ScriptedModel(script=[TimeoutError(), AIMessage(content="完成")])
        agent = graph.create_lma_agent(model, agent_tools=[], retry_delay=0)
        result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
        self.assertEqual(result["messages"][-1].content, "完成")
        self.assertEqual(len(model.inputs), 2)
        model = ScriptedModel(script=[TimeoutError() for _ in range(3)])
        agent = graph.create_lma_agent(model, agent_tools=[], checkpointer=InMemorySaver(), retry_delay=0)
        config = {"configurable": {"thread_id": "model-failure"}}
        with self.assertRaises(TimeoutError):
            await agent.ainvoke({"messages": [HumanMessage(content="查询")]}, config)
        self.assertEqual((await agent.aget_state(config)).values["messages"][-1].content, "查询")

    async def test_elapsed_time_and_official_updates_nodes(self):
        model = ScriptedModel(script=[AIMessage(content="完成", additional_kwargs={"reasoning_content": "证据"})])
        agent = graph.create_lma_agent(model, agent_tools=[])
        with patch.object(graph, "perf_counter", side_effect=[10, 11.25]):
            updates = [update async for update in agent.astream(
                {"messages": [HumanMessage(content="查询")]}, stream_mode="updates",
            )]
        response = next(update["model"]["messages"][0] for update in updates if "model" in update)
        self.assertEqual(response.additional_kwargs["lma_thinking_duration_ms"], 1250)
        self.assertFalse(any("agent" in update or "recommend" in update or "manage_context" in update
                             for update in updates))
