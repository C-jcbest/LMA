"""调查简报的服务端校验：依据必须真实，分层必须成立，失败可由模型修正。"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from app.agent import graph, summarization
from app.agent.message_context import evidence_id
from app.agent.report import REPORT_TOOL_NAME, InvestigationReportInput, _validate_report, report_in_last_turn, submit_investigation_report
from app.agent.tool_protocol import ToolFailure, tool_result
from runtime_fixtures import ScriptedModel


@tool(response_format="content_and_artifact")
async def fake_gnss() -> tuple[str, dict]:
    """测试用 GNSS 工具。"""
    return tool_result({
        "station_uuid": "11111111-1111-1111-1111-111111111111", "station_name": "测试点 A",
        "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00",
        "sampling": "hourly", "points": [], "comparisons": {},
        "features": {"n": {"count": 169, "net_change_mm": -2, "trend_supported": True, "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00"}},
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
            "station_uuid": support()["station_uuid"],
            "begin_time": support()["begin_time"], "end_time": support()["end_time"], "supports": [support()],
            "station_name": "测试点 A", "status": "需人工复核", "reason": "长期同向变化",
            "acceleration": "无法判断", "data_quality": "数据完整",
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
    async def test_station_stability_requires_all_three_axes_not_only_one_direction(self):
        from copy import deepcopy
        original = await fake_gnss.ainvoke({'type': 'tool_call', 'name': 'fake_gnss', 'id': 'gnss-1', 'args': {}})
        args = deepcopy(report_call().tool_calls[0]['args'])
        args['stations'][0]['status'] = '未见明显变化'
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(args), [original])
        features = original.artifact['data']['features']
        features['e'] = deepcopy(features['n'])
        features['u'] = deepcopy(features['n'])
        _validate_report(InvestigationReportInput.model_validate(args), [original])
        features['u'].update(count=2, trend_supported=False)
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(args), [original])

    async def test_acceleration_requires_two_windows_of_same_axis_and_analysis(self):
        from copy import deepcopy
        original = await fake_gnss.ainvoke({'type': 'tool_call', 'name': 'fake_gnss', 'id': 'gnss-1', 'args': {}})
        feature = original.artifact['data']['features']['n']
        first = {**feature, 'end_time': '2026-11-04 00:00:00'}
        second = {**feature, 'begin_time': '2026-11-04 00:00:00'}
        original.artifact['data']['comparisons'] = {'n': {'first': first, 'second': second}, 'u': {'second': second}}
        args = deepcopy(report_call().tool_calls[0]['args'])
        left = {**support(), 'claim': 'trend', 'scope': 'first_window', 'end_time': first['end_time']}
        right = {**support(), 'claim': 'trend', 'scope': 'second_window', 'begin_time': second['begin_time'], 'axis': 'u'}
        args['stations'][0].update(acceleration='疑似加速', supports=[left, right])
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(args), [original])
        args['stations'][0]['supports'][1]['axis'] = 'n'
        _validate_report(InvestigationReportInput.model_validate(args), [original])

    async def test_quality_cannot_borrow_common_station_or_subset_window(self):
        from app.agent.report import EvidenceSupport, _validate_support
        original = await fake_gnss.ainvoke({'type': 'tool_call', 'name': 'fake_gnss', 'id': 'gnss-1', 'args': {}})
        artifact = original.artifact
        other = '22222222-2222-2222-2222-222222222222'
        artifact['data']['comparisons']['station_names'] = {other: 'B'}
        cases = [
            {**support(), 'claim': 'data_quality', 'scope': 'common_period', 'station_uuid': other},
            {**support(), 'claim': 'data_quality', 'begin_time': '2026-11-02 00:00:00'},
        ]
        for item in cases:
            with self.subTest(item=item), self.assertRaises(ToolFailure):
                _validate_support(EvidenceSupport.model_validate(item), artifact)

    async def test_station_and_finding_cannot_borrow_another_station_observations(self):
        from copy import deepcopy
        original = await fake_gnss.ainvoke({'type': 'tool_call', 'name':'fake_gnss', 'id':'gnss-1', 'args':{}})
        args = report_call().tool_calls[0]['args']
        other = '22222222-2222-2222-2222-222222222222'
        directory = ToolMessage(content='站点目录', tool_call_id='directory', artifact={
            'kind':'station_list', 'data':{'stations':[{'station_uuid':other,'station_name':'B'}]},
        })
        borrowed = deepcopy(args)
        borrowed['stations'].append({**borrowed['stations'][0], 'station_uuid':other, 'station_name':'B'})
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(borrowed), [original, directory])
        wrong_finding = deepcopy(args)
        wrong_finding['findings'][0]['station_uuids'] = [support()['station_uuid'], other]
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(wrong_finding), [original, directory])

    async def test_failure_can_be_delivered_as_unavailable_but_not_stable(self):
        args = report_call().tool_calls[0]['args']
        failure_support = {**support(), 'claim':'unavailable', 'axis':None}
        failure = ToolMessage(content='无权限', status='error', tool_call_id='gnss-1', artifact={
            'kind':'acquisition_failure', 'status':'error', 'data':{
                'station_uuid': support()['station_uuid'], 'station_name':'测试点 A',
                'begin_time':support()['begin_time'], 'end_time':support()['end_time'], 'message':'无权限',
            },
        })
        args['stations'] = [{**args['stations'][0], 'status':'暂无法分析', 'supports':[failure_support]}]
        args['findings'] = [{'level':'fact', 'text':'未能取得该站数据', 'supports':[failure_support]}]
        _validate_report(InvestigationReportInput.model_validate(args), [failure])
        args['stations'][0]['status'] = '未见明显变化'
        with self.assertRaises(ToolFailure):
            _validate_report(InvestigationReportInput.model_validate(args), [failure])

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

    async def test_successful_report_does_not_end_before_parallel_progress_failure_is_explained(self):
        @tool
        async def failed_progress() -> str:
            """模拟并行目标更新因版本冲突而失败。"""
            raise ToolFailure('调查版本冲突，目标尚未更新')

        mixed = report_call()
        mixed = AIMessage(
            id=mixed.id, content=mixed.content,
            tool_calls=[*mixed.tool_calls, {'id': 'progress-conflict', 'name': 'failed_progress', 'args': {}}],
        )
        model = ScriptedModel(script=[gnss_call(), mixed, AIMessage(content='简报已生成，目标更新失败，调查尚未完成。')])
        agent = graph.create_lma_agent(
            model, agent_tools=[fake_gnss, submit_investigation_report, failed_progress],
            summary_model=ScriptedModel(script=[]), checkpointer=InMemorySaver(),
        )
        result = await agent.ainvoke(
            {'messages': [HumanMessage(content='调查测点') ]},
            {'configurable': {'thread_id': 'report-progress-conflict'}},
        )
        self.assertEqual(len(model.inputs), 3)
        self.assertIn('调查尚未完成', result['messages'][-1].text)
        self.assertIsNotNone(report_in_last_turn(result['messages']))
        failed = next(message for message in result['messages'] if getattr(message, 'tool_call_id', '') == 'progress-conflict')
        self.assertEqual(failed.status, 'error')

    async def test_fact_sentence_is_generated_from_actual_scope_not_model_numbers(self):
        finding = {"supports": [support()], "level": "fact", "text": "只有25点，北向净变化999 mm"}
        result, _ = await self.run_agent(gnss_call(), report_call(findings=[finding]))
        report = result["messages"][-1]
        sentence = report.artifact["data"]["findings"][0]["text"]
        self.assertIn("有效点 169", sentence)
        self.assertIn("净变化 -2 mm", sentence)
        self.assertIn("单站窗口", sentence)
        self.assertNotIn("999", sentence)
        self.assertNotIn("只有25点", report.content)

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
            "station_uuid": support()["station_uuid"],
            "begin_time": support()["begin_time"], "end_time": support()["end_time"], "supports": [support()],
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
