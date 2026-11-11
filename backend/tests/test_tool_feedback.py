"""参数纠错不产生取数证据；生产工厂、当前协议与存量读取共用回归。"""
import asyncio
import copy
import os
import sys
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import ValidationError

from app.agent.graph import create_lma_agent
from app.agent.message_context import is_evidence
from app.agent.numerical_tool import NumericalInput, analyze_gnss_numerically
from app.agent.report import submit_investigation_report
from app.agent.tool_feedback import is_tool_feedback
from app.beidou.client import BeidouApiError
from app.config import Settings
from app.observations import sampling_calendar
from app.server.investigation_models import InvestigationTarget
from app.server.messages import project_message, project_state
from app.server.storage import SessionStorage, connection_pool, migrate_database
from runtime_fixtures import ScriptedModel

STATION = '11111111-1111-1111-1111-111111111111'
VALID_WINDOW = dict(station_name_or_uuid=STATION, begin_time='2025-11-11 00:00:00', end_time='2026-11-11 11:57:00', sampling='daily')
INVALID_WINDOW = {**VALID_WINDOW, 'begin_time': '2024-11-11 00:00:00'}


def query(identifier, args):
    return AIMessage(content='', tool_calls=[{'id': identifier, 'name': 'analyze_gnss_numerically', 'args': args}])


def legacy_failure():
    text = '工具参数不符合要求，请修正后重新调用。Value error, daily数值回查单次不超过365天，请分窗或选择每日采样'
    return ToolMessage(name='analyze_gnss_numerically', tool_call_id='legacy-call', content=text, status='error', artifact={
        'version': 1, 'kind': 'acquisition_failure', 'status': 'error',
        'data': {'station_uuid': STATION, 'station_name': '测试点', 'requested_station': STATION,
                 'begin_time': VALID_WINDOW['begin_time'], 'end_time': VALID_WINDOW['end_time'], 'message': text},
        'error': {'code': 'unavailable', 'category': 'business', 'message': text, 'retryable': False},
    })


class ToolFeedbackTests(unittest.TestCase):
    def test_daily_bound_is_actual_closed_sampling_calendar(self):
        NumericalInput.model_validate(VALID_WINDOW)
        self.assertEqual(len(sampling_calendar(VALID_WINDOW['begin_time'], VALID_WINDOW['end_time'], sample_times=['15:00'])), 365)
        for fields in (
            {'end_time': '2026-11-11 15:00:00'},
            {'begin_time': '2025-11-10 00:00:00'},
            {'begin_time': '2025-11-11 15:00:00', 'end_time': '2026-11-11 15:00:00'},
            {**INVALID_WINDOW, 'split_time': '2026-01-01 00:00:00'},
        ):
            with self.subTest(fields=fields), self.assertRaisesRegex(ValidationError, '365个每日15:00'):
                NumericalInput.model_validate({**VALID_WINDOW, **fields})
        hourly = {**VALID_WINDOW, 'sampling': 'hourly', 'begin_time': '2026-09-10 11:57:00'}
        NumericalInput.model_validate(hourly)
        with self.assertRaisesRegex(ValidationError, '62天.*daily'):
            NumericalInput.model_validate({**hourly, 'begin_time': '2026-09-10 11:56:59'})

    def test_legacy_feedback_requires_exact_validation_source_and_original_invalid_window(self):
        from app.agent.report import _current_turn_evidence
        from app.server.investigations import station_identities

        message = legacy_failure()
        original = message.model_dump(mode='json')
        self.assertTrue(is_tool_feedback(message))
        self.assertFalse(is_evidence(message))
        self.assertEqual(_current_turn_evidence([HumanMessage(content='查看趋势'), message]), [])
        self.assertEqual(station_identities([message]), {})
        projected = project_message(message)
        self.assertEqual(projected['status'], 'error')
        self.assertEqual(projected['artifact']['kind'], 'tool_feedback')
        self.assertNotIn('Value error', str(projected))
        self.assertEqual(message.model_dump(mode='json'), original)
        for change in ('different_tool', 'valid_window', 'timeout', 'unproven_content'):
            with self.subTest(change=change):
                other = copy.deepcopy(message)
                if change == 'different_tool':
                    other.name = 'query_weather'
                elif change == 'valid_window':
                    other.artifact['data']['begin_time'] = '2026-11-01 00:00:00'
                elif change == 'timeout':
                    other.content = '数据服务暂不可用'
                    other.artifact['error']['message'] = other.content
                    other.artifact['data']['message'] = other.content
                else:
                    other.content = '工具参数不符合要求，另一个业务限制'
                self.assertFalse(is_tool_feedback(other))
                self.assertEqual(project_message(other)['artifact']['kind'], 'acquisition_failure')


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

    def run_scenario(self, scenario):
        async def run():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '内部纠错回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    await scenario(storage, session, saver)
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
        asyncio.run(run(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)

    def test_repeated_corrections_reach_model_without_persisting_false_acquisition_failures(self):
        async def scenario(storage, session, saver):
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.get_daily_data.return_value = []
            station = SimpleNamespace(station_type=3, station_uuid=STATION, station_name='测试点', device_uuid='test-device')
            model = ScriptedModel(script=[query('bad-daily', INVALID_WINDOW), query('bad-hourly', {**INVALID_WINDOW, 'sampling': 'hourly'}),
                                          query('corrected', VALID_WINDOW), AIMessage(content='已查询目标原窗，观测为空，无法判断位移趋势。')])
            agent = create_lma_agent(model, agent_tools=[analyze_gnss_numerically], checkpointer=saver, investigation_storage=storage, summary_model=ScriptedModel(script=[]))
            with patch('app.agent.numerical_tool._build_client', return_value=client), patch('app.agent.numerical_tool._resolve_station', return_value=station):
                result = await agent.ainvoke({'messages': [HumanMessage(content='查看趋势')]}, {'configurable': {'thread_id': session}})
            client.get_daily_data.assert_awaited_once_with(station_uuid=STATION, begin_time=VALID_WINDOW['begin_time'], end_time=VALID_WINDOW['end_time'], sample_times=['15:00'])
            results = [item for item in result['messages'] if isinstance(item, ToolMessage)]
            self.assertEqual([item.status for item in results], ['error', 'error', 'success'])
            self.assertTrue(all(is_tool_feedback(item) and item.artifact is None for item in results[:2]))
            self.assertIn('365个', model.inputs[1][-1].text)
            self.assertIn('62天', model.inputs[2][-1].text)
            self.assertEqual([row['snapshot']['kind'] for row in await storage.evidence(session)], ['numerical'])
            self.assertNotIn('Value error', str(project_state(result)))
            restored = await agent.aget_state({'configurable': {'thread_id': session}})
            self.assertEqual(project_state(restored.values), project_state(result))
        self.run_scenario(scenario)

    def test_report_correction_and_budget_end_preserve_errors_without_fake_success(self):
        async def scenario(storage, session, saver):
            self.settings.agent_model_run_limit = 3
            model = ScriptedModel(script=[query('invalid', INVALID_WINDOW),
                AIMessage(content='', tool_calls=[{'id': 'bad-report', 'name': 'submit_investigation_report', 'args': {}}]),
                AIMessage(content='未取得可用观测，本轮无法完成调查。')])
            agent = create_lma_agent(model, agent_tools=[analyze_gnss_numerically, submit_investigation_report], checkpointer=saver, investigation_storage=storage, summary_model=ScriptedModel(script=[]))
            result = await agent.ainvoke({'messages': [HumanMessage(content='调查趋势')]}, {'configurable': {'thread_id': session}})
            self.assertTrue(result['messages'][-1].additional_kwargs['lma_budget_exhausted'])
            results = [item for item in result['messages'] if isinstance(item, ToolMessage)]
            self.assertEqual(len(results), 2)
            self.assertTrue(all(item.status == 'error' and is_tool_feedback(item) for item in results))
            self.assertEqual(await storage.evidence(session), [])
            self.assertIn('未取得可用观测', str(project_state(result)))
            self.assertNotIn('Field required', str(project_state(result)))
        self.run_scenario(scenario)

    def test_real_permission_and_timeout_failures_remain_business_evidence(self):
        async def scenario(storage, session, saver):
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.get_daily_data.side_effect = failure
            station = SimpleNamespace(station_type=3, station_uuid=STATION, station_name='测试点', device_uuid='test-device')
            model = ScriptedModel(script=[query('permission', VALID_WINDOW), AIMessage(content='权限不足，本轮未取得该站观测。')])
            agent = create_lma_agent(model, agent_tools=[analyze_gnss_numerically], investigation_storage=storage, summary_model=ScriptedModel(script=[]))
            with patch('app.agent.numerical_tool._build_client', return_value=client), patch('app.agent.numerical_tool._resolve_station', return_value=station):
                result = await agent.ainvoke({'messages': [HumanMessage(content='查看趋势')]}, {'configurable': {'thread_id': session}})
            message = next(item for item in result['messages'] if isinstance(item, ToolMessage))
            self.assertFalse(is_tool_feedback(message))
            self.assertEqual(message.artifact['kind'], 'acquisition_failure')
            self.assertEqual(len(await storage.evidence(session)), 1)
            self.assertIn(public_message, str(project_state(result)))
            self.assertNotIn('private diagnostic', str(project_state(result)))
        for failure, public_message in (
            (BeidouApiError('PRIVATE', 'private diagnostic'), '访问权限'),
            (httpx.ReadTimeout('private diagnostic'), '数据服务暂不可用'),
        ):
            with self.subTest(error=type(failure).__name__):
                self.run_scenario(scenario)

    def test_legacy_false_evidence_is_preserved_but_cannot_support_any_target_outcome(self):
        async def scenario(storage, session, saver):
            message = legacy_failure()
            record = await storage.save_evidence(session, message.tool_call_id, message.artifact, message=message.model_dump(mode='json', exclude={'artifact'}))
            self.assertIsNone(await storage.evidence_item(session, str(record['id'])))
            self.assertEqual((await storage.evidence_catalog(session))['items'], [])
            self.assertEqual(await storage.evidence(session), [])
            async with storage.pool.connection() as connection:
                row = await (await connection.execute('SELECT snapshot FROM lma_evidence WHERE id=%s', (record['id'],))).fetchone()
                self.assertEqual(row['snapshot'], message.artifact)
                for outcome in ('answered', 'insufficient', 'blocked'):
                    target = InvestigationTarget(target_id='A', station_uuid=STATION, begin_time=VALID_WINDOW['begin_time'], end_time=VALID_WINDOW['end_time'], question='趋势', outcome=outcome, result='参数错误不是观测事实', evidence_ids=[record['id']])
                    with self.assertRaisesRegex(ValueError, '参数纠错未执行取数'):
                        await storage._validate_target_evidence(connection, session, target)
        self.run_scenario(scenario)
