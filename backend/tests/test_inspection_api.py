"""巡检接口：手动触发、结果持久化、与上次对比，以及调查结论的关联。"""

import asyncio
import json
import os
import sys
import time
import unittest
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from app.agent.graph import create_lma_agent
from app.agent.report import submit_investigation_report
from app.beidou.client import BeidouApiError
from app.beidou.schemas import GnssDataPoint, Station
from app.business_time import business_now
from app.config import Settings
from app.server.api import create_app
from app.server.storage import migrate_database
from runtime_fixtures import ScriptedModel
from test_investigation_report import fake_gnss, gnss_call, report_call

DATABASE_URI = os.environ.get("LMA_TEST_DATABASE_URI", "")


def station(name, station_type=3):
    return Station(
        StationGroupUUID="group", StationGroupName="K3", StationUUID=f"uuid-{name}", StationName=name,
        StationType=station_type, StationN0="100", StationE0="200", StationU0="300",
    )


class FakeBeidou:
    """测试点 B 的日序列在 unavailable 时报错，用于验证单点失败不影响其余测点。"""

    def __init__(self, unavailable=False):
        self.unavailable = unavailable

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return None

    async def get_stations(self):
        return [station("测试点 A"), station("测试点 B"), station("基准站 R", station_type=1)]

    async def get_daily_data(self, station_uuid, begin_time, end_time, sampling_frequency=None, sample_times=None):
        if self.unavailable and station_uuid == "uuid-测试点 B":
            raise BeidouApiError("500", "PRIVATE_UPSTREAM")
        now = business_now().replace(tzinfo=None, microsecond=0)
        count = 90 if sample_times else 168
        step = timedelta(days=1) if sample_times else timedelta(hours=1)
        rate = 0.0002 if station_uuid == "uuid-测试点 A" and sample_times else 0
        return [
            GnssDataPoint(
                DataTime=(now - step * (count - i)).strftime("%Y-%m-%d %H:%M:%S"),
                PJKInfoN=str(100 - i * rate), PJKInfoE="200", PJKInfoU="300",
            )
            for i in range(count)
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
            agent_factory=lambda saver: create_lma_agent(
                self.model, agent_tools=[fake_gnss, submit_investigation_report],
                summary_model=ScriptedModel(tags=["nostream"], script=[]), checkpointer=saver,
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
