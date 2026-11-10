"""调查关联只使用本轮已完成回答及实际涉及的测点。"""
import unittest

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.server.investigations import investigation_record


class StationInvestigationTests(unittest.TestCase):
    def test_previous_turn_and_directory_do_not_create_station_associations(self):
        messages = [
            HumanMessage(content="旧问题", additional_kwargs={"lma_context": {"focus_station": "旧测点"}}),
            AIMessage(id="old", content="旧回答"),
            HumanMessage(content="列出测点"),
            ToolMessage(content="目录", tool_call_id="directory", artifact={
                "kind": "station_list", "data": {"stations": [{"station_name": "A"}]},
            }),
            AIMessage(id="answer", content="已列出测点"),
        ]
        self.assertIsNone(investigation_record(messages))

    def test_successful_query_records_answer_but_failed_query_does_not(self):
        query = ToolMessage(content="记录", tool_call_id="query", artifact={
            "kind": "gnss_series", "data": {"station_name": "A", "station_uuid": "uuid-A"},
        })
        messages = [HumanMessage(content="近期变化"), query, AIMessage(id="answer", content="北向缓慢变化")]
        self.assertEqual(investigation_record(messages), {
            "anchor_id": "answer", "report_tool_call_id": None, "stations": [{"station_name": "A", "station_uuid": "uuid-A"}], "question": "近期变化",
        })
        query.status = "error"
        self.assertIsNone(investigation_record(messages))

    def test_reasoning_without_visible_answer_is_not_a_completed_investigation(self):
        messages = [
            HumanMessage(content="近期变化", additional_kwargs={"lma_context": {"focus_station": "A"}}),
            AIMessage(id="reasoning", content=[{"type": "reasoning", "reasoning": "内部推理"}]),
        ]
        self.assertIsNone(investigation_record(messages))
