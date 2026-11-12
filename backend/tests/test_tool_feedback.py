"""参数纠错只回给模型修正，不产生取数依据；真实取数失败仍是可登记的依据。"""
import asyncio
import os
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import ValidationError

from app.agent.conclusions import record_conclusions
from app.agent.graph import create_lma_agent
from app.agent.tool_feedback import is_tool_feedback
from app.agent.tool_inputs import DisplacementInput
from app.agent.tools import get_displacement
from app.beidou.client import BeidouApiError
from app.beidou.schemas import Station
from app.config import Settings
from app.server.messages import project_state
from app.server.storage import SessionStorage, connection_pool, migrate_database
from runtime_fixtures import FakePlatform, ScriptedModel

STATION = Station(station_uuid='11111111-1111-1111-1111-111111111111', station_name='测试点', station_type=3,
                  group_uuid='g', group_name='测试组')
VALID_WINDOW = dict(station_name_or_uuid=STATION.station_uuid, begin_time='2026-01-01 00:00:00', end_time='2026-11-01 00:00:00')
TOO_LONG_HOURLY = {**VALID_WINDOW, 'begin_time': '2025-01-01 00:00:00'}


def query(identifier, args):
    return AIMessage(content='', tool_calls=[{'id': identifier, 'name': 'get_displacement', 'args': args}])


class DisplacementInputTests(unittest.TestCase):
    def test_schema_rejects_what_the_model_can_correct_before_any_request(self):
        DisplacementInput.model_validate({**VALID_WINDOW, 'sampling': 'daily', 'sample_times': ['03:00', '15:00']})
        for fields, message in (
            ({'sample_times': ['15:00']}, 'daily'),
            ({'sampling': 'daily', 'sample_times': ['15:30']}, '整点'),
            ({'split_time': '2027-01-01 00:00:00'}, '窗口内部'),
            ({'end_time': VALID_WINDOW['begin_time']}, '早于'),
        ):
            with self.subTest(fields=fields), self.assertRaisesRegex(ValidationError, message):
                DisplacementInput.model_validate({**VALID_WINDOW, **fields})


async def evidence_kinds(storage, session):
    async with storage.pool.connection() as connection:
        cursor = await connection.execute(
            "SELECT snapshot->>'kind' AS kind FROM lma_evidence WHERE session_id=%s ORDER BY acquired_at", (session,),
        )
        return [row['kind'] for row in await cursor.fetchall()]


@unittest.skipUnless(os.environ.get('LMA_TEST_DATABASE_URI'), '需配置隔离lma_test数据库')
class PersistedToolFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.uri = os.environ['LMA_TEST_DATABASE_URI']
        if not self.uri.endswith('/lma_test'):
            raise ValueError('只允许隔离lma_test数据库')
        self.settings = Settings(_env_file=None, context_model_context=1048576, agent_max_retries=0, agent_model_run_limit=5)
        patcher = patch('app.agent.graph.get_settings', return_value=self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_scenario(self, scenario, platform):
        async def run():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '内部纠错回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    with patch('app.monitoring_data.build_platform_client', return_value=platform):
                        await scenario(storage, session, saver)
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
        asyncio.run(run(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)

    def test_over_long_window_is_corrected_without_persisting_a_false_acquisition_failure(self):
        platform = FakePlatform(stations=[STATION])

        async def scenario(storage, session, saver):
            model = ScriptedModel(script=[query('too-long', TOO_LONG_HOURLY), query('corrected', VALID_WINDOW),
                                          AIMessage(content='已查询目标窗口，观测为空，无法判断位移趋势。')])
            agent = create_lma_agent(model, agent_tools=[get_displacement], checkpointer=saver, storage=storage,
                                     summary_model=ScriptedModel(script=[]))
            result = await agent.ainvoke({'messages': [HumanMessage(content='查看趋势')]}, {'configurable': {'thread_id': session}})
            results = [item for item in result['messages'] if isinstance(item, ToolMessage)]
            self.assertEqual([item.status for item in results], ['error', 'success'])
            self.assertTrue(is_tool_feedback(results[0]) and results[0].artifact is None)
            self.assertIn('366', model.inputs[1][-1].text)
            self.assertEqual(await evidence_kinds(storage, session), ['gnss_series'])
            self.assertTrue(all(request[1] >= '2025-12-01' for request in platform.requests))
            restored = await agent.aget_state({'configurable': {'thread_id': session}})
            self.assertEqual(project_state(restored.values), project_state(result))
        self.run_scenario(scenario, platform)

    def test_invalid_conclusions_and_budget_end_preserve_errors_without_fake_success(self):
        async def scenario(storage, session, saver):
            self.settings.agent_model_run_limit = 2
            model = ScriptedModel(script=[
                AIMessage(content='', tool_calls=[{'id': 'bad-conclusions', 'name': 'record_conclusions', 'args': {}}]),
                AIMessage(content='未取得可用观测，本轮无法完成调查。')])
            agent = create_lma_agent(model, agent_tools=[get_displacement, record_conclusions], checkpointer=saver,
                                     storage=storage, summary_model=ScriptedModel(script=[]))
            result = await agent.ainvoke({'messages': [HumanMessage(content='调查趋势')]}, {'configurable': {'thread_id': session}})
            self.assertTrue(result['messages'][-1].additional_kwargs['lma_budget_exhausted'])
            results = [item for item in result['messages'] if isinstance(item, ToolMessage)]
            self.assertTrue(all(item.status == 'error' and is_tool_feedback(item) for item in results))
            self.assertEqual(await evidence_kinds(storage, session), [])
            self.assertIn('未取得可用观测', str(project_state(result)))
            self.assertNotIn('Field required', str(project_state(result)))
        self.run_scenario(scenario, FakePlatform(stations=[STATION]))

    def test_real_permission_and_timeout_failures_remain_business_evidence(self):
        for failure, public_message in (
            (BeidouApiError('PRIVATE', 'private diagnostic'), '访问权限'),
            (httpx.ReadTimeout('private diagnostic'), '数据服务暂不可用'),
        ):
            platform = FakePlatform(stations=[STATION])

            async def get_daily_data(*args, **kwargs):
                raise failure

            platform.get_daily_data = get_daily_data

            async def scenario(storage, session, saver):
                model = ScriptedModel(script=[query('permission', VALID_WINDOW), AIMessage(content='本轮未取得该站观测。')])
                agent = create_lma_agent(model, agent_tools=[get_displacement], storage=storage, summary_model=ScriptedModel(script=[]))
                result = await agent.ainvoke({'messages': [HumanMessage(content='查看趋势')]}, {'configurable': {'thread_id': session}})
                message = next(item for item in result['messages'] if isinstance(item, ToolMessage))
                self.assertFalse(is_tool_feedback(message))
                self.assertEqual(message.artifact['kind'], 'acquisition_failure')
                self.assertEqual(await evidence_kinds(storage, session), ['acquisition_failure'])
                self.assertIn(public_message, str(project_state(result)))
                self.assertNotIn('private diagnostic', str(project_state(result)))

            with self.subTest(error=type(failure).__name__):
                self.run_scenario(scenario, platform)
