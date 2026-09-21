"""生产 create_agent 工厂回归；使用可控模型，不访问真实平台。"""

import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch


from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from app.agent import graph, summarization
from app.beidou.client import BeidouApiError
from runtime_fixtures import ScriptedModel, call


class AgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = SimpleNamespace(
            recommend_enabled=False, agent_max_retries=2, agent_retry_initial_delay=0.5, agent_retry_max_delay=4.0,
            agent_model_run_limit=20, agent_tool_run_limit=40, context_token_threshold=800_000,
            context_model_context=1_048_576,
            context_keep_tokens=400000, context_summary_max_tokens=2000, llm_model="test",
        )
        for module in (graph, summarization):
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

        model = ScriptedModel(profile={"max_input_tokens": 1_048_576}, script=[call(), AIMessage(
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
        self.assertEqual(result["context_usage"]["input_tokens"], 321)
        self.assertEqual(result["context_usage"]["max_input_tokens"], 1_048_576)
        self.assertAlmostEqual(result["context_usage"]["usage_ratio"], 321 / 1_048_576)
        self.assertEqual(model.inputs[0][0].content, model.inputs[1][0].content)
        with patch.object(graph, "business_now", return_value=second):
            result = await agent.ainvoke({"messages": [HumanMessage(content="昨天呢？")]}, config)
        self.assertEqual(len(result["messages"]), 6)
        self.assertEqual(result["messages"][4].additional_kwargs["created_at"], second.isoformat())
        self.assertNotIn("business_time", result)
        self.assertEqual(result["context_usage"]["input_tokens"], 321)

    async def test_recommendations_generated_from_final_answer_and_cleared_each_run(self):
        self.settings.recommend_enabled = True
        model = ScriptedModel(script=[AIMessage(content="完整最终回答"), AIMessage(content="第二轮回答")])
        agent = graph.create_lma_agent(model, agent_tools=[], checkpointer=InMemorySaver())
        bound_structured = SimpleNamespace(ainvoke=AsyncMock(return_value=graph.RecommendationResult(
            recommendations=["查看近期趋势", "对比同组测点"],
        )))
        recommend = SimpleNamespace(with_structured_output=MagicMock(return_value=bound_structured))
        config = {"configurable": {"thread_id": "recommend-test"}}
        with patch.object(graph, "_get_recommend_llm", return_value=recommend):
            first = await agent.ainvoke({"messages": [HumanMessage(content="查询")],
                                         "recommendations": ["旧建议"]}, config)
            self.assertEqual(first["recommendations"], ["查看近期趋势", "对比同组测点"])
            self.assertIn("完整最终回答", bound_structured.ainvoke.call_args.args[0][-1].content)
            self.settings.recommend_enabled = False
            second = await agent.ainvoke({"messages": [HumanMessage(content="继续")]}, config)
        self.assertEqual(second["recommendations"], [])
        self.assertEqual(bound_structured.ainvoke.call_count, 1)


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

    async def test_official_updates_nodes(self):
        model = ScriptedModel(script=[AIMessage(content="完成", additional_kwargs={"reasoning_content": "证据"})])
        agent = graph.create_lma_agent(model, agent_tools=[])
        updates = [update async for update in agent.astream(
            {"messages": [HumanMessage(content="查询")]}, stream_mode="updates",
        )]
        response = next(update["model"]["messages"][0] for update in updates if "model" in update)
        self.assertIn("created_at", response.additional_kwargs)
        self.assertNotIn("lma_thinking_duration_ms", response.additional_kwargs)
        self.assertFalse(any("agent" in update or "recommend" in update or "manage_context" in update
                             for update in updates))

    async def test_nonstandard_reasoning_fields_are_not_promoted(self):
        model = ScriptedModel(script=[AIMessage(
            content="完成",
            additional_kwargs={"reasoning": "不得提升", "thinking": "不得提升"},
            response_metadata={"reasoning_content": "不得提升"},
        )])
        agent = graph.create_lma_agent(model, agent_tools=[])
        result = await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
        response = result["messages"][-1]
        self.assertNotIn("reasoning_content", response.additional_kwargs)

    async def test_model_budget_stops_loop_and_resets_next_run(self):
        from langchain.agents.middleware.model_call_limit import ModelCallLimitExceededError
        self.settings.agent_model_run_limit = 2
        calls = []
        @tool
        def station():
            """读取站点证据。"""
            calls.append(1)
            return "已取得证据"
        model = ScriptedModel(script=[call("c1"), call("c2"), AIMessage(content="下一轮可以继续")])
        agent = graph.create_lma_agent(model, agent_tools=[station], checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "limited"}}
        with self.assertRaises(ModelCallLimitExceededError):
            await agent.ainvoke({"messages": [HumanMessage(content="循环查询")]}, config)
        self.assertEqual(len(model.inputs), 2)
        self.assertEqual(len(calls), 2)
        state = (await agent.aget_state(config)).values
        self.assertEqual(len([m for m in state["messages"] if m.type == "tool"]), 2)
        result = await agent.ainvoke({"messages": [HumanMessage(content="下一轮")]}, config)
        self.assertEqual(result["messages"][-1].content, "下一轮可以继续")

    async def test_tool_budget_blocks_only_exceeded_calls_and_preserves_usage(self):
        self.settings.agent_tool_run_limit = 1
        calls = []
        @tool
        def station():
            """读取站点。"""
            calls.append(1)
            return "真实证据"
        request = AIMessage(content="", tool_calls=[*call("c1").tool_calls, *call("c2").tool_calls])
        model = ScriptedModel(profile={"max_input_tokens": 1_048_576}, script=[request, AIMessage(content="说明限制",
            usage_metadata={"input_tokens": 123, "output_tokens": 2, "total_tokens": 125})])
        result = await graph.create_lma_agent(model, agent_tools=[station]).ainvoke({"messages": [HumanMessage(content="查询")]})
        self.assertEqual(len(calls), 1)
        results = [m for m in result["messages"] if m.type == "tool"]
        self.assertEqual(len(results), 2)
        self.assertEqual({m.status for m in results}, {"success", "error"})
        self.assertEqual(result["context_usage"]["input_tokens"], 123)

    async def test_official_retry_backoff_for_model_and_tool(self):
        for target in ("model", "tool"):
            with self.subTest(target=target):
                attempts = []
                @tool
                def station():
                    """测试指数退避。"""
                    attempts.append(1)
                    if len(attempts) < 3:
                        raise TimeoutError()
                    return "证据"
                script = [TimeoutError(), TimeoutError(), AIMessage(content="完成")] if target == "model" else [call(), AIMessage(content="完成")]
                agent = graph.create_lma_agent(ScriptedModel(script=script), agent_tools=[station])
                with patch("langchain.agents.middleware._retry.random.uniform", return_value=0), \
                     patch(f"langchain.agents.middleware.{target}_retry.asyncio.sleep", new_callable=AsyncMock) as sleep:
                    await agent.ainvoke({"messages": [HumanMessage(content="查询")]})
                delays = [c.args[0] for c in sleep.await_args_list if c.args[0] > 0]
                self.assertEqual(delays, [0.5, 1.0])

    async def test_sanitize_unanswered_tool_calls_cleans_interrupted_run(self):
        """测试服务端自愈：前轮被中断遗留的未配对 tool_calls 在新一轮开始前被清洗。"""
        @tool
        def station():
            """读取站点。"""
            return "真实证据"

        interrupted_ai = AIMessage(content="", tool_calls=[{"id": "c1", "name": "station", "args": {}}])
        model = ScriptedModel(script=[AIMessage(content="正常回答")])
        checkpointer = InMemorySaver()
        agent = graph.create_lma_agent(model, agent_tools=[station], checkpointer=checkpointer)
        config = {"configurable": {"thread_id": "interrupted-thread"}}

        # 向 thread 写入包含未完成 tool_calls 的历史消息（模拟客户端 stop/cancel）
        await agent.aupdate_state(
            config,
            {"messages": [HumanMessage(content="查询"), interrupted_ai]},
        )

        result = await agent.ainvoke({"messages": [HumanMessage(content="下一轮提问")]}, config)
        self.assertEqual(result["messages"][-1].content, "正常回答")
        first_input_messages = model.inputs[0]
        self.assertNotIn(interrupted_ai, first_input_messages)

    async def test_tool_error_middleware_catches_generic_tool_exception(self):
        """测试通用异常只由 ToolErrorMiddleware 转换为受控错误消息。"""
        @tool
        def faulty_tool():
            """故障工具。"""
            raise RuntimeError("unexpected database disk failure")

        model = ScriptedModel(script=[
            AIMessage(content="", tool_calls=[{"id": "faulty_call", "name": "faulty_tool", "args": {}}]),
            AIMessage(content="解释限制"),
        ])
        agent = graph.create_lma_agent(model, agent_tools=[faulty_tool])
        result = await agent.ainvoke({"messages": [HumanMessage(content="触发故障")]})
        tool_messages = [m for m in result["messages"] if m.type == "tool"]
        self.assertEqual(len(tool_messages), 1)
        self.assertEqual(tool_messages[0].status, "error")
        self.assertEqual(tool_messages[0].content, "工具执行失败，未取得可用数据，请说明这一限制。")
        self.assertIsNone(tool_messages[0].artifact)

    async def test_platform_business_error_is_not_retried_or_exposed(self):
        attempts = []

        @tool
        def rejected_tool():
            """模拟监测平台业务拒绝。"""
            attempts.append(1)
            raise BeidouApiError("PRIVATE_CODE", "secret vendor response")

        model = ScriptedModel(script=[
            AIMessage(content="", tool_calls=[{
                "id": "rejected_call", "name": "rejected_tool", "args": {},
            }]),
            AIMessage(content="说明限制"),
        ])
        with self.assertLogs(graph.logger, level="WARNING"):
            result = await graph.create_lma_agent(
                model, agent_tools=[rejected_tool], retry_delay=0,
            ).ainvoke({"messages": [HumanMessage(content="触发业务拒绝")]})

        message = next(m for m in result["messages"] if m.type == "tool")
        self.assertEqual(attempts, [1])
        self.assertEqual(message.status, "error")
        self.assertIn("监测平台拒绝本次查询", message.content)
        self.assertNotIn("PRIVATE_CODE", str(message))
        self.assertNotIn("secret vendor response", str(message))
        self.assertIsNone(message.artifact)

    async def test_parallel_tools_stream_mode_finish_independently(self):
        """测试生产链路：真实 stream_mode="tools" 下同批并行工具独立完成，tool-finished 携带 artifact。"""
        import asyncio
        import time

        @tool(response_format="content_and_artifact")
        async def tool_quick() -> tuple[str, dict]:
            """Tool Quick"""
            await asyncio.sleep(0.1)
            return "已查询测点快", {
                "version": 1,
                "kind": "station_list",
                "status": "success",
                "data": {"stations": [{"station_name": "测点快"}]},
            }

        @tool(response_format="content_and_artifact")
        async def tool_medium() -> tuple[str, dict]:
            """Tool Medium"""
            await asyncio.sleep(0.3)
            return "已查询分组中", {
                "version": 1,
                "kind": "station_list",
                "status": "success",
                "data": {"groups": [{"group_name": "分组中"}]},
            }

        @tool(response_format="content_and_artifact")
        async def tool_slow() -> tuple[str, dict]:
            """Tool Slow"""
            await asyncio.sleep(0.5)
            return "已查询测点慢", {
                "version": 1,
                "kind": "gnss_series",
                "status": "success",
                "data": {"station_name": "测点慢", "points": []},
            }

        model = ScriptedModel(script=[
            AIMessage(content="", tool_calls=[
                {"id": "call-1", "name": "tool_quick", "args": {}},
                {"id": "call-2", "name": "tool_medium", "args": {}},
                {"id": "call-3", "name": "tool_slow", "args": {}},
            ]),
            AIMessage(content="所有工具均已完成"),
        ])
        agent = graph.create_lma_agent(
            model,
            agent_tools=[tool_quick, tool_medium, tool_slow],
            retry_delay=0,
            summary_model=ScriptedModel(script=[]),
        )

        # 直接消费前端 useChannel(["tools"]) 对应的 stream_mode="tools" 事件流
        t0 = time.monotonic()
        finished = []
        async for _ns, mode, payload in agent.astream(
            {"messages": [HumanMessage(content="查询数据")]},
            stream_mode=["tools"],
            subgraphs=True,
        ):
            if (
                mode == "tools"
                and isinstance(payload, dict)
                and payload.get("event") == "tool-finished"
            ):
                finished.append({
                    "time": time.monotonic() - t0,
                    "id": payload["tool_call_id"],
                    "output": payload["output"],
                })

        # 1. 三个工具都独立产生真实的 tool-finished 事件
        self.assertEqual(len(finished), 3)

        # 2. 完成顺序是 quick -> medium -> slow
        self.assertEqual(
            [item["id"] for item in finished],
            ["call-1", "call-2", "call-3"],
        )

        # 3. 时间阶梯递增：quick 先于 medium，medium 先于 slow 完成
        self.assertLess(finished[0]["time"], finished[1]["time"])
        self.assertLess(finished[1]["time"], finished[2]["time"])

        # 4. output 为携带严格 version: 1 artifact 的 ToolMessage，
        #    与 Agent Server wire protocol -> useChannel -> getLiveToolArtifact 同源
        quick_output = finished[0]["output"]
        self.assertIsInstance(quick_output, ToolMessage)
        self.assertEqual(quick_output.artifact["version"], 1)
        self.assertEqual(quick_output.artifact["kind"], "station_list")
        self.assertEqual(quick_output.artifact["status"], "success")
        self.assertEqual(
            quick_output.artifact["data"]["stations"][0]["station_name"],
            "测点快",
        )

        medium_output = finished[1]["output"]
        self.assertIsInstance(medium_output, ToolMessage)
        self.assertEqual(
            medium_output.artifact["data"]["groups"][0]["group_name"],
            "分组中",
        )

        slow_output = finished[2]["output"]
        self.assertIsInstance(slow_output, ToolMessage)
        self.assertEqual(
            slow_output.artifact["data"]["station_name"],
            "测点慢",
        )
