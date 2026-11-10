"""调查简报的服务端校验：依据必须真实，分层必须成立，失败可由模型修正。"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from app.agent import graph, summarization
from app.agent.message_context import evidence_id
from app.agent.report import REPORT_TOOL_NAME, report_in_last_turn, submit_investigation_report
from app.agent.tool_protocol import tool_result
from runtime_fixtures import ScriptedModel


@tool(response_format="content_and_artifact")
async def fake_gnss() -> tuple[str, dict]:
    """测试用 GNSS 工具。"""
    return tool_result({
        "station_uuid": "11111111-1111-1111-1111-111111111111", "station_name": "测试点 A",
        "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00",
        "sampling": "hourly", "points": [], "comparisons": {},
        "features": {"n": {"count": 2, "net_change_mm": -2, "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00"}},
    }, kind="numerical")



def gnss_call():
    return AIMessage(id="ai-gnss", content="", tool_calls=[{"id": "gnss-1", "name": "fake_gnss", "args": {}}])


def support():
    return {"evidence_id": evidence_id("gnss-1"), "station_uuid": "11111111-1111-1111-1111-111111111111",
            "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00",
            "claim": "numeric_change", "axis": "n", "rationale": "窗口净变化数值支持"}


def report_call(call_id="report-1", **overrides):
    args = {
        "conclusion": "测试点 A 需要优先复核。",
        "stations": [{
            "station_name": "测试点 A", "status": "需人工复核", "reason": "长期同向变化",
            "acceleration": "未见持续加速", "data_quality": "数据完整",
        }],
        "findings": [
            {"supports": [support()], "level": "fact", "text": "北向净变化 -2 mm"},
            {"supports": [support()], "level": "inference", "text": "可能与坡体缓慢变形有关"},
        ],
        "next_steps": ["核查观测墩"],
        **overrides,
    }
    return AIMessage(id=f"ai-{call_id}", content="", tool_calls=[{"id": call_id, "name": REPORT_TOOL_NAME, "args": args}])


class InvestigationReportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings = SimpleNamespace(agent_max_retries=0, agent_retry_initial_delay=0, agent_retry_max_delay=0,
            agent_model_run_limit=20, agent_tool_run_limit=40, llm_model="test", context_token_threshold=100000,
            context_model_context=100000, context_keep_tokens=1000, context_summary_max_tokens=2000)
        for module in (graph, summarization):
            patcher = patch.object(module, "get_settings", return_value=settings)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def run_agent(self, *script):
        model = ScriptedModel(script=list(script))
        agent = graph.create_lma_agent(
            model, agent_tools=[fake_gnss, submit_investigation_report],
            summary_model=ScriptedModel(tags=["nostream"], script=[]), checkpointer=InMemorySaver(),
        )
        result = await agent.ainvoke(
            {"messages": [HumanMessage(id="q", content="测试点 A 最近怎么样？")]},
            {"configurable": {"thread_id": "report-test"}},
        )
        return result, model

    async def test_valid_report_ends_the_turn_and_resolves_evidence(self):
        result, model = await self.run_agent(gnss_call(), report_call())
        self.assertEqual(len(model.inputs), 2)
        self.assertIn(f'<lma_evidence id="{evidence_id("gnss-1")}"/>', model.inputs[1][-1].content)
        last = result["messages"][-1]
        self.assertEqual(last.name, REPORT_TOOL_NAME)
        self.assertEqual(last.status, "success")
        self.assertEqual(last.artifact["kind"], "investigation_report")
        self.assertEqual(last.artifact["data"]["findings"][0]["evidence"], ["gnss-1"])
        self.assertEqual(report_in_last_turn(result["messages"])[0], "report-1")
        self.assertNotIn("lma_evidence", result["messages"][2].content)

    async def test_invalid_report_returns_to_model_for_correction(self):
        cases = {
            "编造依据": report_call("bad", findings=[{"level": "fact", "text": "x", "supports": [{**support(), "evidence_id": "Efake00"}]}]),
            "事实无依据": report_call("bad", findings=[{"level": "fact", "text": "x", "supports": []}]),
            "旧引用字段": report_call("bad", findings=[{"level": "fact", "text": "x", "supports": [support()], "evidence_ids": [evidence_id("gnss-1")]}]),
            "未调查测点": report_call("bad", stations=[{
                "station_name": "不存在的点", "status": "持续关注", "reason": "r",
                "acceleration": "无法判断", "data_quality": "q",
            }]),
            "时间窗不匹配": report_call("bad", findings=[{"supports": [{**support(), "end_time": "2027-01-01 00:00:00"}], "level": "fact", "text": "变化"}]),
        }
        for name, bad_report in cases.items():
            with self.subTest(name):
                result, model = await self.run_agent(gnss_call(), bad_report, report_call("good"))
                self.assertEqual(len(model.inputs), 3)
                failed = next(m for m in result["messages"] if getattr(m, "tool_call_id", "") == "bad")
                self.assertEqual(failed.status, "error")
                self.assertIsNone(failed.artifact)
                self.assertEqual(report_in_last_turn(result["messages"])[0], "good")

    async def test_inference_accepts_natural_wording_without_required_keywords(self):
        finding = {"supports": [support()], "level": "inference", "text": "从变化形态看，更倾向于坡体缓慢变形。"}
        result, model = await self.run_agent(gnss_call(), report_call(findings=[finding]))
        self.assertEqual(len(model.inputs), 2)
        self.assertEqual(result["messages"][-1].status, "success")
        self.assertEqual(result["messages"][-1].artifact["data"]["findings"][0]["text"], finding["text"])

    async def test_plain_answer_is_still_allowed(self):
        result, _ = await self.run_agent(AIMessage(content="共有 3 个分组。"))
        self.assertEqual(result["messages"][-1].content, "共有 3 个分组。")
        self.assertIsNone(report_in_last_turn(result["messages"]))

    async def test_plain_answer_after_data_query_does_not_require_report(self):
        result, _ = await self.run_agent(
            gnss_call(), AIMessage(id="plain-data", content="本时段没有监测记录。"),
        )
        self.assertEqual(result["messages"][-1].content, "本时段没有监测记录。")
        self.assertIsNone(report_in_last_turn(result["messages"]))

    async def test_report_can_omit_irrelevant_station_details(self):
        result, _ = await self.run_agent(gnss_call(), report_call(stations=[{
            "station_name": "测试点 A", "status": "数据不足", "reason": "本时段没有监测记录",
        }]))
        station = result["messages"][-1].artifact["data"]["stations"][0]
        self.assertNotIn("acceleration", station)
        self.assertEqual(station["data_quality"], "")

    async def test_only_current_turn_evidence_can_be_cited(self):
        model = ScriptedModel(script=[gnss_call(), report_call(), report_call("stale"), AIMessage(content="未能提交")])
        agent = graph.create_lma_agent(
            model, agent_tools=[fake_gnss, submit_investigation_report],
            summary_model=ScriptedModel(tags=["nostream"], script=[]), checkpointer=InMemorySaver(),
        )
        config = {"configurable": {"thread_id": "report-turns"}}
        await agent.ainvoke({"messages": [HumanMessage(id="q1", content="第一轮")]}, config)
        result = await agent.ainvoke({"messages": [HumanMessage(id="q2", content="第二轮")]}, config)
        stale = next(m for m in result["messages"] if getattr(m, "tool_call_id", "") == "stale")
        self.assertEqual(stale.status, "error")
        self.assertIn("不在本轮查询结果", json.dumps(stale.content, ensure_ascii=False))
