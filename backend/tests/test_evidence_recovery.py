"""工具存证与官方checkpoint边界故障，全部使用隔离数据库和生产Agent工厂。"""
import asyncio
import os
import subprocess
import sys
import socket
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
import httpx

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.evidence import _commit_completed, reconcile_evidence
from app.agent.graph import create_lma_agent
from app.server.storage import SessionStorage, connection_pool, migrate_database
from runtime_fixtures import ScriptedModel

STATION = '11111111-1111-1111-1111-111111111111'


def snapshot(station=STATION, begin='2026-11-01 00:00:00', end='2026-11-02 00:00:00'):
    return {'version': 1, 'kind': 'numerical', 'status': 'success', 'data': {
        'station_uuid': station, 'station_name': '故障回归站', 'begin_time': begin, 'end_time': end,
        'features': {'n': {'count': 25}}, 'points': [], 'comparisons': {}, 'sampling': 'hourly',
    }}


@tool(response_format='content_and_artifact')
async def observation() -> tuple[str, dict]:
    """取得一份隔离的数值证据。"""
    return '已取得数值观测', snapshot()


def run_async(function):
    return asyncio.run(function(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)


@unittest.skipUnless(os.environ.get('LMA_TEST_DATABASE_URI'), '需配置隔离数据库')
class EvidenceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.uri = os.environ['LMA_TEST_DATABASE_URI']
        if not self.uri.endswith('/lma_test'):
            raise ValueError('只允许隔离lma_test数据库')

    def test_legacy_record_migration_uses_only_unique_identity_in_original_turn(self):
        from app.server.storage import migrate_domain_records

        ambiguous_one = str(uuid4())
        ambiguous_two = str(uuid4())
        later_station = str(uuid4())

        def catalog(call_id, stations):
            return ToolMessage(
                id=call_id, name='list_stations', tool_call_id=call_id, content='原始台账',
                artifact={'kind': 'station_list', 'status': 'success', 'data': {'stations': stations}},
            )

        messages = [
            HumanMessage(id='old-question', content='原始调查'),
            AIMessage(id='old-query', content='', tool_calls=[{'id': 'old-list', 'name': 'list_stations', 'args': {}}]),
            catalog('old-list', [
                {'station_uuid': STATION, 'station_name': '历史唯一站'},
                {'station_uuid': ambiguous_one, 'station_name': '历史同名站'},
                {'station_uuid': ambiguous_two, 'station_name': '历史同名站'},
            ]),
            AIMessage(id='old-answer', content='原回答，只保存名称而未保存观测UUID'),
            HumanMessage(id='later-question', content='另一次调查'),
            AIMessage(id='later-query', content='', tool_calls=[{'id': 'later-list', 'name': 'list_stations', 'args': {}}]),
            catalog('later-list', [{'station_uuid': later_station, 'station_name': '仅后续回合出现的站'}]),
            AIMessage(id='later-answer', content='后续回答'),
        ]

        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '历史身份迁移回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    agent = create_lma_agent(
                        ScriptedModel(script=[]), agent_tools=[observation], checkpointer=saver,
                        investigation_storage=storage, summary_model=ScriptedModel(script=[]),
                    )
                    await agent.aupdate_state({'configurable': {'thread_id': session}}, {'messages': messages}, as_node='tools')
                    async with pool.connection() as connection:
                        for name in ('历史唯一站', '历史同名站', '仅后续回合出现的站'):
                            await connection.execute(
                                """INSERT INTO lma_station_investigations
                                   (session_id,anchor_id,station_name,report_tool_call_id,question)
                                   VALUES (%s,'old-answer',%s,'old-report','原始调查')""",
                                (session, name),
                            )
                        await connection.execute(
                            """INSERT INTO lma_station_conclusions
                               (session_id,tool_call_id,station_name,status,reason)
                               VALUES (%s,'old-report','历史唯一站','未见明显变化','原结论')""", (session,),
                        )
                    await migrate_domain_records(pool)
                    await migrate_domain_records(pool)
                    records = [row for row in await storage.station_records(STATION) if str(row['session_id']) == session]
                    self.assertEqual(len(records), 1)
                    self.assertEqual(records[0]['anchor_id'], 'old-answer')
                    self.assertFalse(records[0]['validated'])
                    self.assertIsNone(records[0]['status'])
                    self.assertEqual(records[0]['historical_status'], '未见明显变化')
                    for station in (ambiguous_one, ambiguous_two, later_station):
                        rows = [row for row in await storage.station_records(station) if str(row['session_id']) == session]
                        self.assertEqual(rows, [])
                    async with pool.connection() as connection:
                        cursor = await connection.execute(
                            'SELECT count(*) AS count FROM lma_station_investigations WHERE session_id=%s', (session,),
                        )
                        self.assertEqual((await cursor.fetchone())['count'], 3)
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
        run_async(scenario)

    def test_report_index_survives_failure_after_tools_before_agent_finalization(self):
        from app.agent.report import submit_investigation_report
        from app.agent.evidence import EvidenceMiddleware
        from test_investigation_report import fake_gnss, gnss_call, report_call

        async def fail_after_agent(self, state, runtime):
            raise RuntimeError('模拟工具已完成、Agent收尾之前发生故障')

        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '报告索引事务边界回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    with patch.object(EvidenceMiddleware, 'aafter_agent', new=fail_after_agent):
                        agent = create_lma_agent(
                            ScriptedModel(script=[gnss_call(), report_call()]),
                            agent_tools=[fake_gnss, submit_investigation_report], checkpointer=saver,
                            investigation_storage=storage, summary_model=ScriptedModel(script=[]),
                        )
                        with self.assertRaisesRegex(RuntimeError, 'Agent收尾之前'):
                            await agent.ainvoke(
                                {'messages': [HumanMessage(content='复核并留档')]},
                                {'configurable': {'thread_id': session}},
                            )
                    evidence = await storage.evidence(session)
                    self.assertTrue(any(item['snapshot']['kind'] == 'investigation_report' for item in evidence))
                    records = [item for item in await storage.station_records(STATION) if str(item['session_id']) == session]
                    self.assertEqual(len(records), 1)
                    self.assertEqual(records[0]['status'], '需人工复核')
                    self.assertTrue(records[0]['validated'])
                    self.assertEqual(records[0]['anchor_id'], 'report-1')

                    # 模拟只剩官方checkpoint的报告；索引失败须回滚快照，重试须一起补全。
                    state = await agent.aget_state({'configurable': {'thread_id': session}})
                    async with pool.connection() as connection:
                        async with connection.transaction():
                            await connection.execute(
                                'DELETE FROM lma_evidence WHERE session_id=%s AND tool_call_id=%s',
                                (session, 'report-1'),
                            )
                            await connection.execute('DELETE FROM lma_station_results WHERE session_id=%s', (session,))
                            await connection.execute('DELETE FROM lma_station_records WHERE session_id=%s', (session,))
                    with patch.object(storage, '_record_investigation', side_effect=RuntimeError('模拟报告索引写入失败')):
                        with self.assertRaisesRegex(RuntimeError, '索引写入失败'):
                            await reconcile_evidence(storage, session, state.values['messages'])
                    remaining = await storage.evidence(session)
                    self.assertFalse(any(item['snapshot']['kind'] == 'investigation_report' for item in remaining))
                    conclusions = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                    self.assertEqual(conclusions, [])
                    await reconcile_evidence(storage, session, state.values['messages'])
                    await reconcile_evidence(storage, session, state.values['messages'])
                    restored = [item for item in await storage.station_records(STATION) if str(item['session_id']) == session]
                    self.assertEqual(len(restored), 1)
                    self.assertTrue(restored[0]['validated'])
                    self.assertEqual(len(await storage.evidence(session)), len(evidence))
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
        run_async(scenario)

    def test_stage_report_leaves_model_a_chance_to_finish_recorded_targets(self):
        from app.agent.report import submit_investigation_report, report_in_last_turn
        from test_investigation_report import fake_gnss, gnss_call, report_call

        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '阶段简报与调查结束回归')
                try:
                    evidence = await storage.save_evidence(session, 'previous', snapshot())
                    identifier = str(uuid4())
                    record = await storage.save_progress(session, identifier, {
                        'goal': '检查原窗口变化', 'covered': ['A'],
                        'targets': [{
                            'target_id': 'A', 'station_uuid': STATION,
                            'begin_time': '2026-11-01T00:00:00', 'end_time': '2026-11-02T00:00:00',
                            'question': '窗口内有什么变化', 'outcome': 'answered',
                            'result': '已取得适用数值', 'evidence_ids': [str(evidence['id'])],
                        }],
                    })
                    model = ScriptedModel(script=[
                        gnss_call(), report_call(),
                        AIMessage(content='', tool_calls=[{
                            'id': 'finish', 'name': 'finish_investigation',
                            'args': {'investigation_id': identifier, 'revision': record['revision'],
                                     'conclusion': '目标已逐项回答，调查结束'},
                        }]),
                        AIMessage(content='调查已结束，阶段简报保留。'),
                    ])
                    agent = create_lma_agent(
                        model, agent_tools=[fake_gnss, submit_investigation_report],
                        checkpointer=AsyncPostgresSaver(pool), investigation_storage=storage,
                        summary_model=ScriptedModel(script=[]),
                    )
                    result = await agent.ainvoke(
                        {'messages': [HumanMessage(content='完成原调查并留档')]},
                        {'configurable': {'thread_id': session}},
                    )
                    self.assertEqual((await storage.investigation(session, identifier))['status'], 'completed')
                    self.assertIsNotNone(report_in_last_turn(result['messages']))
                    self.assertIn('调查已结束', result['messages'][-1].text)
                finally:
                    await storage.delete(session)
                    await AsyncPostgresSaver(pool).adelete_thread(session)
        run_async(scenario)

    def test_real_sse_disconnect_preserves_completed_parallel_tool(self):
        async def scenario():
            await migrate_database(self.uri)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            backend = str(Path(__file__).resolve().parents[1])
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name('recovery_worker.py')), '--serve', str(port)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={**os.environ, 'PYTHONPATH': os.pathsep.join([backend, str(Path(__file__).parent)])},
            )
            session = None
            try:
                async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=10, trust_env=False) as client:
                    async with asyncio.timeout(15):
                        while True:
                            if process.poll() is not None:
                                self.fail('隔离SSE服务提前退出')
                            try:
                                if (await client.get('/health')).status_code == 200:
                                    break
                            except httpx.ConnectError:
                                pass
                            await asyncio.sleep(.05)
                    session = (await client.post('/sessions', json={'name': '断流故障回归'})).json()['id']
                    async with client.stream('POST', f'/sessions/{session}/runs', json={
                        'messages': [{'type': 'human', 'id': str(uuid4()), 'content': '读取并行观测'}],
                    }) as stream:
                        self.assertEqual(stream.status_code, 200)
                        async with asyncio.timeout(10):
                            async for line in stream.aiter_lines():
                                if '已取得数值观测' in line:
                                    break
                            while not (await client.get(f'/sessions/{session}/evidence')).json()['items']:
                                await asyncio.sleep(.02)
                    # 关闭真实HTTP连接；另一个工具仍在取数，整轮尚无完成的tools checkpoint。
                    async with asyncio.timeout(10):
                        while True:
                            state = (await client.get(f'/sessions/{session}/state')).json()
                            if state['latest_run']['status'] != 'running':
                                break
                            await asyncio.sleep(.02)
                    self.assertEqual(state['latest_run']['status'], 'cancelled')
                    results = [message for message in state['values']['messages'] if message['type'] == 'tool']
                    self.assertEqual([message['tool_call_id'] for message in results], ['completed-observation'])
                    self.assertEqual(results[0]['artifact']['kind'], 'numerical')
                    catalog = (await client.get(f'/sessions/{session}/evidence')).json()['items']
                    self.assertEqual(len(catalog), 1)
                    refreshed = (await client.get(f'/sessions/{session}/state')).json()
                    self.assertEqual(refreshed['values']['messages'], state['values']['messages'])
            finally:
                process.terminate()
                await asyncio.to_thread(process.wait, timeout=10)
                if session:
                    async with connection_pool(self.uri) as pool:
                        await pool.wait()
                        await SessionStorage(pool).delete(session)
                        await AsyncPostgresSaver(pool).adelete_thread(session)
        run_async(scenario)

    def test_process_exit_after_evidence_commit_recovers_without_reexecuting_tool(self):
        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '进程故障回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    backend = str(Path(__file__).resolve().parents[1])
                    process = await asyncio.to_thread(
                        subprocess.run, [sys.executable, str(Path(__file__).with_name('recovery_worker.py')), session],
                        capture_output=True, timeout=30,
                        env={**os.environ, 'PYTHONPATH':os.pathsep.join([backend, str(Path(__file__).parent)])},
                    )
                    self.assertEqual(process.returncode, 73, process.stderr.decode('utf-8', errors='replace')[-2000:])
                    evidence = await storage.evidence(session)
                    self.assertEqual(len(evidence), 1)
                    model = ScriptedModel(script=[AIMessage(content='根据已取得证据继续解释')])
                    agent = create_lma_agent(model, agent_tools=[observation], checkpointer=saver,
                                             investigation_storage=storage, summary_model=ScriptedModel(script=[]))
                    config = {'configurable': {'thread_id': session}}
                    state = await agent.aget_state(config)
                    recovered = await reconcile_evidence(storage, session, state.values['messages'])
                    self.assertEqual(len(recovered), 1)
                    self.assertEqual(recovered[0].artifact, evidence[0]['snapshot'])
                    config = await agent.aupdate_state(state.config, {'messages': recovered}, as_node='tools')
                    with patch(__name__ + '.observation.coroutine', side_effect=AssertionError('不得重放已取得的观测')):
                        result = await agent.ainvoke({'messages': [HumanMessage(content='解释原证据')]}, config)
                    self.assertIn('根据已取得证据', result['messages'][-1].text)
                    self.assertEqual(len(await storage.evidence(session)), 1)
                    self.assertEqual(await reconcile_evidence(storage, session, result['messages']), [])
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
        run_async(scenario)

    def test_checkpoint_only_result_is_reconciled_idempotently_and_refresh_is_new(self):
        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '存证对账')
                try:
                    messages = [AIMessage(id='original', content='', tool_calls=[{'id':'observation', 'name':'observation', 'args':{}}]),
                                ToolMessage(id='completed', content='观测', tool_call_id='observation', name='observation', artifact=snapshot())]
                    first = await reconcile_evidence(storage, session, messages)
                    second = await reconcile_evidence(storage, session, messages)
                    self.assertEqual(first[0].additional_kwargs['lma_evidence_uuid'], second[0].additional_kwargs['lma_evidence_uuid'])
                    self.assertEqual(len(await storage.evidence(session)), 1)
                    refresh = await storage.save_evidence(session, 'observation', snapshot(), execution_id='refresh')
                    self.assertNotEqual(str(refresh['id']), first[0].additional_kwargs['lma_evidence_uuid'])
                    self.assertEqual(len(await storage.evidence(session)), 2)
                finally:
                    await storage.delete(session)
        run_async(scenario)

    def test_cancellation_during_commit_finishes_short_write_and_storage_failure_is_visible(self):
        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '取消存证回归')
                try:
                    entered = asyncio.Event()
                    save = storage.save_evidence

                    async def delayed(*args, **kwargs):
                        entered.set()
                        await asyncio.sleep(.05)
                        return await save(*args, **kwargs)

                    message = ToolMessage(content='已完成观测', tool_call_id='cancelled-write', name='observation', artifact=snapshot())
                    with patch.object(storage, 'save_evidence', side_effect=delayed):
                        commit = asyncio.create_task(_commit_completed(storage, session, 'executing', message))
                        await entered.wait()
                        commit.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await commit
                    self.assertEqual(len(await storage.evidence(session)), 1)
                    with patch.object(storage, 'save_evidence', side_effect=OSError('隔离故障注入')):
                        with self.assertRaises(OSError):
                            await _commit_completed(storage, session, 'uncommitted', message)
                    self.assertIsNone(await storage.executed_evidence(session, 'uncommitted', message.tool_call_id))
                finally:
                    await storage.delete(session)
        run_async(scenario)

    def test_target_updates_reject_stale_revision_and_wrong_station_window_or_kind(self):
        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '目标并发回归')
                try:
                    evidence = await storage.save_evidence(session, 'valid', snapshot())
                    target = {'station_uuid': STATION, 'begin_time':'2026-11-01T00:00:00',
                              'end_time':'2026-11-02T00:00:00', 'question':'检查窗口变化'}
                    identifier = str(uuid4())
                    record = await storage.save_progress(session, identifier, {
                        'goal':'复核两目标', 'targets':[{**target, 'target_id':key} for key in ('A','B')],
                    })
                    async def answer(key, revision):
                        return await storage.update_target(session, identifier, key, outcome='answered', result='已核对数值',
                                                           evidence_ids=[str(evidence['id'])], expected_revision=revision)
                    outcomes = await asyncio.gather(answer('A', record['revision']), answer('B', record['revision']), return_exceptions=True)
                    self.assertEqual(sum(isinstance(value, ValueError) for value in outcomes), 1)
                    record = await storage.investigation(session, identifier)
                    pending = next(item['target_id'] for item in record['progress']['targets'] if item['outcome'] == 'pending')
                    record = await answer(pending, record['revision'])
                    self.assertEqual(set(record['progress']['covered']), {'A','B'})
                    for call_id, invalid in (
                        ('wrong-station', snapshot(station=str(uuid4()))),
                        ('wrong-window', snapshot(begin='2025-11-01 00:00:00', end='2025-11-02 00:00:00')),
                        ('wrong-kind', {**snapshot(), 'kind':'gnss_series'}),
                        ('failed', {**snapshot(), 'status':'error'}),
                    ):
                        saved = await storage.save_evidence(session, call_id, invalid)
                        with self.subTest(call_id=call_id), self.assertRaises(ValueError):
                            await storage.update_target(session, identifier, 'A', outcome='answered', result='伪造完成',
                                                        evidence_ids=[str(saved['id'])], expected_revision=record['revision'])
                    withdrawn = await storage.withdraw_target(session, identifier, 'B', reason='用户缩小问题范围',
                        source='user_request', message_id='request', expected_revision=record['revision'])
                    self.assertEqual(len(withdrawn['progress']['targets']), 2)
                    self.assertEqual(withdrawn['progress']['changes'][-1]['source'], 'user_request')
                    self.assertEqual(withdrawn['progress']['covered'], ['A'])
                    completed = await storage.finish_investigation(session, identifier, '已回答A，B按用户请求撤回', withdrawn['revision'])
                    self.assertEqual(completed['status'], 'completed')
                finally:
                    await storage.delete(session)
        run_async(scenario)
