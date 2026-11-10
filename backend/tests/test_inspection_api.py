"""巡检接口：手动触发、结果持久化、与上次对比，以及调查结论的关联。"""

import asyncio
import json
import os
import sys
import time
import unittest
import httpx
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.agent.graph import create_lma_agent
from app.agent.report import submit_investigation_report
from app.beidou.client import BeidouApiError
from app.beidou.schemas import GnssDataPoint, Station
from app.business_time import business_now
from app.observations import sampling_calendar
from app.config import Settings
from app.server.api import create_app
from app.server.storage import migrate_database
from runtime_fixtures import ScriptedModel
from test_investigation_report import fake_gnss, gnss_call, report_call

DATABASE_URI = os.environ.get("LMA_TEST_DATABASE_URI", "")


def station(name, station_type=3):
    return Station(
        StationGroupUUID="group", StationGroupName="K3", StationUUID="11111111-1111-1111-1111-111111111111" if name == "测试点 A" else f"uuid-{name}", StationName=name,
        StationType=station_type, StationN0="100", StationE0="200", StationU0="300",
    )


class FakeBeidou:
    """测试点 B 的日序列在 unavailable 时报错，用于验证单点失败不影响其余测点。"""

    def __init__(self, unavailable=False):
        self.unavailable = unavailable
        self.station_list_unavailable = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return None

    async def get_stations(self):
        if self.station_list_unavailable:
            raise BeidouApiError("500", "PRIVATE_UPSTREAM")
        return [station("测试点 A"), station("测试点 B"), station("基准站 R", station_type=1)]

    async def get_daily_data(self, station_uuid, begin_time, end_time, sampling_frequency=None, sample_times=None):
        if self.unavailable and station_uuid == "uuid-测试点 B":
            raise BeidouApiError("500", "PRIVATE_UPSTREAM")
        moments = sampling_calendar(begin_time, end_time, sample_times=sample_times)
        rate = 0.0002 if station_uuid == "11111111-1111-1111-1111-111111111111" and sample_times else 0
        return [
            GnssDataPoint(
                DataTime=moment,
                PJKInfoN=str(100 - i * rate), PJKInfoE="200", PJKInfoU="300",
            )
            for i, moment in enumerate(moments)
        ]


@unittest.skipUnless(DATABASE_URI, "需配置隔离 LMA_TEST_DATABASE_URI")
class InspectionApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATABASE_URI.rstrip("/").endswith("/lma_test"):
            raise ValueError("API 测试只允许使用名为 lma_test 的隔离数据库。")
        loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
        asyncio.run(migrate_database(DATABASE_URI), loop_factory=loop_factory)

    def setUp(self):
        settings = Settings(
            _env_file=None, database_uri=DATABASE_URI, context_model_context=100000,
            context_token_threshold=90000, context_keep_tokens=1000, agent_max_retries=0,
        )
        patcher = patch("app.agent.graph.get_settings", return_value=settings)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch("app.agent.summarization.get_settings", return_value=settings)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.beidou = FakeBeidou()
        self.model = ScriptedModel(script=[gnss_call(), report_call()])
        app = create_app(
            settings,
            agent_factory=lambda saver, storage: create_lma_agent(
                self.model, agent_tools=[fake_gnss, submit_investigation_report],
                summary_model=ScriptedModel(tags=["nostream"], script=[]), checkpointer=saver, investigation_storage=storage,
            ),
            inspection_client_factory=lambda: self.beidou,
        )
        options = {"loop_factory": asyncio.SelectorEventLoop} if sys.platform == "win32" else {}
        self.client = self.enterContext(TestClient(app, backend_options=options))

    def inspect(self):
        self.assertEqual(self.client.post("/inspections").status_code, 202)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            latest = self.client.get("/inspections/latest").json()
            if latest["running"] is None:
                return latest
            time.sleep(0.05)
        self.fail("巡检未在限定时间内完成")

    def by_name(self, latest):
        return {row["station_name"]: row for row in latest["stations"]}

    def test_simultaneous_inspection_requests_start_only_one_scan(self):
        async def scenario():
            release = asyncio.Event()
            original_start = self.client.app.state.storage.start_inspection
            original_stations = self.beidou.get_stations

            async def save_start(identifier):
                await asyncio.sleep(.02)
                await original_start(identifier)

            async def held_stations():
                await release.wait()
                return await original_stations()

            transport = httpx.ASGITransport(app=self.client.app)
            with patch.object(self.client.app.state.storage, 'start_inspection', side_effect=save_start) as start, \
                    patch.object(self.beidou, 'get_stations', side_effect=held_stations):
                try:
                    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
                        results = await asyncio.gather(client.post('/inspections'), client.post('/inspections'))
                    self.assertEqual(sorted(response.status_code for response in results), [202, 409])
                    self.assertEqual(start.await_count, 1)
                finally:
                    release.set()

        self.client.portal.call(scenario)

    def test_station_sessions_are_explicitly_scoped_and_latest_unarchived_first(self):
        sessions = []
        for station_uuid in [None, "uuid-A", "uuid-B", "uuid-A"]:
            body = {"name": "独立调查", "station_uuid": station_uuid}
            response = self.client.post("/sessions", json=body)
            self.assertEqual(response.status_code, 201)
            session = response.json()
            sessions.append(session)
            self.addCleanup(lambda key=session["id"]: self.client.delete(f"/sessions/{key}"))
        latest = self.client.get("/sessions", params={"station_uuid": "uuid-A", "limit": 1}).json()
        self.assertEqual([row["id"] for row in latest], [sessions[3]["id"]])
        self.client.patch(f"/sessions/{sessions[3]['id']}", json={"archived": True})
        remaining = self.client.get("/sessions", params={"station_uuid": "uuid-A"}).json()
        self.assertEqual([row["id"] for row in remaining], [sessions[1]["id"]])
        self.assertEqual(self.client.get("/sessions", params={"station_uuid": "uuid-unknown"}).json(), [])

    def test_directory_does_not_require_inspection_or_model(self):
        remaining = len(self.model.script)
        response = self.client.get("/stations")
        self.assertEqual(response.status_code, 200)
        self.assertEqual({row["station_name"] for row in response.json()}, {"测试点 A", "测试点 B", "基准站 R"})
        self.assertEqual(len(self.model.script), remaining)
        self.beidou.station_list_unavailable = True
        response = self.client.get("/stations")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("PRIVATE_UPSTREAM", response.text)

    def test_legacy_records_without_original_evidence_stay_in_global_records(self):
        session_id = self.client.post("/sessions", json={"name": "历史简报迁移"}).json()["id"]
        self.addCleanup(lambda: self.client.delete(f"/sessions/{session_id}"))
        storage = self.client.app.state.storage
        async def seed_legacy():
            async with storage.pool.connection() as connection:
                await connection.execute("INSERT INTO lma_station_conclusions(session_id,tool_call_id,station_name,status,reason) VALUES (%s,'old-report','测试点 A','持续关注','历史判断')", (session_id,))
        self.client.portal.call(seed_legacy)
        self.client.portal.call(migrate_database, DATABASE_URI)
        self.client.portal.call(migrate_database, DATABASE_URI)
        records = self.client.portal.call(storage.station_records, "11111111-1111-1111-1111-111111111111")
        migrated = [row for row in records if str(row["session_id"]) == session_id]
        self.assertEqual(migrated, [])
        self.assertEqual(self.client.get(f"/sessions/{session_id}").status_code, 200)
        conclusions = self.client.get('/sessions/conclusions').json()
        self.assertFalse(any(row['session_id'] == session_id for row in conclusions))

    def test_record_links_use_uuid_even_when_names_match(self):
        storage = self.client.app.state.storage
        session_id = self.client.post('/sessions', json={'name': '同名测点'}).json()['id']
        self.addCleanup(lambda: self.client.delete(f'/sessions/{session_id}'))
        record = {
            'anchor_id': 'answer', 'report_tool_call_id': None, 'question': '对比测点',
            'stations': [{'station_uuid': 'uuid-one', 'station_name': '同名'},
                         {'station_uuid': 'uuid-two', 'station_name': '同名'}],
        }
        self.client.portal.call(storage.record_investigation, session_id, record)
        for identifier in ['uuid-one', 'uuid-two']:
            records = self.client.portal.call(storage.station_records, identifier)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['anchor_id'], 'answer')
        self.assertEqual(self.client.portal.call(storage.station_records, '同名'), [])
        self.assertEqual(self.client.portal.call(storage.station_records, 'uuid-three'), [])

    def test_legacy_links_are_restored_from_checkpoint_evidence_idempotently(self):
        session_id = self.client.post('/sessions', json={'name': '证据迁移'}).json()['id']
        self.addCleanup(lambda: self.client.delete(f'/sessions/{session_id}'))
        response = self.client.post(f'/sessions/{session_id}/runs', json={
            'messages': [{'type': 'human', 'id': str(uuid4()), 'content': '调查测点 A'}],
        })
        self.assertEqual(response.status_code, 200)
        storage = self.client.app.state.storage

        async def remove_links():
            async with storage.pool.connection() as connection:
                await connection.execute("INSERT INTO lma_station_conclusions(session_id,tool_call_id,station_name,status,reason) VALUES (%s,'report-1','测试点 A','需人工复核','历史判断')", (session_id,))
                await connection.execute("INSERT INTO lma_station_investigations(session_id,anchor_id,station_name,report_tool_call_id,question) VALUES (%s,'report-1','测试点 A','report-1','原问题')", (session_id,))
                await connection.execute('DELETE FROM lma_station_records WHERE session_id = %s', (session_id,))
                await connection.execute('DELETE FROM lma_station_results WHERE session_id = %s', (session_id,))

        self.client.portal.call(remove_links)
        self.client.portal.call(migrate_database, DATABASE_URI)
        self.client.portal.call(migrate_database, DATABASE_URI)
        records = self.client.portal.call(storage.station_records, '11111111-1111-1111-1111-111111111111')
        own = [record for record in records if str(record['session_id']) == session_id]
        self.assertEqual(len(own), 1)
        self.assertEqual(own[0]['anchor_id'], 'report-1')
        self.assertIsNone(own[0]['status'])
        self.assertEqual(own[0]['historical_status'], '需人工复核')

    def test_plain_answer_is_recorded_with_answer_anchor_without_inventing_status(self):
        self.model.script[:] = [AIMessage(id="plain-answer", content="可以继续观察北向的变化。")]
        session_id = self.client.post("/sessions", json={"name": "自然回答记录", "station_uuid": "11111111-1111-1111-1111-111111111111"}).json()["id"]
        self.addCleanup(lambda: self.client.delete(f"/sessions/{session_id}"))
        self.client.post(f"/sessions/{session_id}/runs", json={
            "messages": [{"type": "human", "id": str(uuid4()), "content": "下一步看什么？"}],
            "focus_station": "测试点 A",
        })
        records = self.client.get("/stations/11111111-1111-1111-1111-111111111111/timeline").json()["records"]
        record = next(row for row in records if row["session_id"] == session_id)
        self.assertEqual(record["anchor_id"], "plain-answer")
        self.assertIsNone(record["status"])
        self.assertEqual(record["reason"], "下一步看什么？")
        self.assertFalse(any(row["session_id"] == session_id for row in self.client.get("/sessions/conclusions").json()))

    def test_inspection_flags_change_and_compares_with_previous_run(self):
        first = self.by_name(self.inspect())
        self.assertNotIn("基准站 R", first)
        self.assertEqual(first["测试点 A"]["screening"], "建议调查")
        self.assertEqual(first["测试点 B"]["screening"], "未见明显变化")

        self.beidou.unavailable = True
        second = self.by_name(self.inspect())
        self.assertEqual(second["测试点 B"]["screening"], "暂无法分析")
        self.assertEqual(second["测试点 B"]["previous_screening"], "未见明显变化")
        self.assertEqual(second["测试点 A"]["screening"], "建议调查")
        self.assertNotIn("PRIVATE_UPSTREAM", json.dumps(second, ensure_ascii=False))

    def test_submitted_report_links_conclusion_to_station(self):
        session_id = self.client.post("/sessions", json={"name": "结论关联"}).json()["id"]
        self.addCleanup(lambda: self.client.delete(f"/sessions/{session_id}"))
        response = self.client.post(f"/sessions/{session_id}/runs", json={
            "messages": [{"type": "human", "id": str(uuid4()), "content": "测试点 A 最近怎么样？"}],
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("investigation_report", response.text)

        rows = self.by_name(self.inspect())
        self.assertEqual(rows["测试点 A"]["last_conclusion"]["status"], "需人工复核")
        self.assertEqual(rows["测试点 A"]["last_conclusion"]["session_id"], session_id)
        self.assertIsNone(rows["测试点 B"]["last_conclusion"])

    def test_station_page_reads_series_and_past_conclusions_without_the_model(self):
        session_id = self.client.post("/sessions", json={"name": "测点页记录"}).json()["id"]
        self.addCleanup(lambda: self.client.delete(f"/sessions/{session_id}"))
        self.client.post(f"/sessions/{session_id}/runs", json={
            "messages": [{"type": "human", "id": str(uuid4()), "content": "最近怎么样？"}],
            "focus_station": "测试点 A",
        })
        calls_after_run = len(self.model.script)

        timeline = self.client.get("/stations/11111111-1111-1111-1111-111111111111/timeline", params={"days": 30}).json()
        self.assertEqual(timeline["station_name"], "测试点 A")
        self.assertEqual(timeline["group_name"], "K3")
        self.assertEqual(timeline["series"]["sampling"]["mode"], "sample_times")
        self.assertEqual(timeline["records"][0]["session_id"], session_id)
        self.assertEqual(timeline["records"][0]["status"], "需人工复核")
        self.assertEqual(len(self.model.script), calls_after_run)

        conclusions = [row for row in self.client.get("/sessions/conclusions").json() if row["session_id"] == session_id]
        self.assertEqual([(row["station_name"], row["status"]) for row in conclusions], [("测试点 A", "需人工复核")])

        self.assertIsNone(self.client.get("/stations/uuid-基准站 R/timeline").json()["series"])
        self.assertEqual(self.client.get("/stations/uuid-不存在/timeline").status_code, 404)
        self.assertEqual(self.client.get("/stations/11111111-1111-1111-1111-111111111111/timeline", params={"days": 5}).status_code, 422)

        self.beidou.unavailable = True
        failed = self.client.get("/stations/uuid-测试点 B/timeline")
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn("PRIVATE_UPSTREAM", failed.text)

    def test_failed_attempt_preserves_success_and_next_success_clears_failure(self):
        successful = self.inspect()
        self.beidou.station_list_unavailable = True
        failed = self.inspect()
        self.assertEqual(failed["latest_attempt"]["status"], "error")
        self.assertIsNotNone(failed["latest_attempt"]["finished_at"])
        self.assertEqual(failed["inspection"]["id"], successful["inspection"]["id"])
        self.assertEqual(failed["stations"], successful["stations"])
        self.assertNotIn("PRIVATE_UPSTREAM", json.dumps(failed, ensure_ascii=False))

        self.beidou.station_list_unavailable = False
        recovered = self.inspect()
        self.assertEqual(recovered["latest_attempt"]["status"], "success")
        self.assertEqual(recovered["latest_attempt"]["id"], recovered["inspection"]["id"])

    def test_interrupted_attempt_preserves_success_and_exposes_terminal_status(self):
        successful = self.inspect()
        storage = self.client.app.state.storage
        inspection_id = str(uuid4())
        self.client.portal.call(storage.start_inspection, inspection_id)
        self.client.portal.call(storage.set_inspection_total, inspection_id, 3)
        running = self.client.get("/inspections/latest").json()
        self.assertEqual(running["running"], {"total_stations": 3, "completed_stations": 0})

        self.client.portal.call(storage.interrupt_previous_runs)
        interrupted = self.client.get("/inspections/latest").json()
        self.assertIsNone(interrupted["running"])
        self.assertEqual(interrupted["latest_attempt"]["id"], inspection_id)
        self.assertEqual(interrupted["latest_attempt"]["status"], "interrupted")
        self.assertIsNotNone(interrupted["latest_attempt"]["finished_at"])
        self.assertEqual(interrupted["inspection"]["id"], successful["inspection"]["id"])
        self.assertEqual(interrupted["stations"], successful["stations"])
