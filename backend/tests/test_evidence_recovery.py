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

from app.agent.conclusions import record_conclusions
from app.agent.evidence import _commit_completed, reconcile_evidence
from app.agent.graph import create_lma_agent
from app.server.storage import SessionStorage, connection_pool, migrate_database
from runtime_fixtures import ScriptedModel

STATION = '11111111-1111-1111-1111-111111111111'


def snapshot(station=STATION, begin='2026-11-01 00:00:00', end='2026-11-02 00:00:00'):
    point = {'time': begin, 'n': 100.0, 'e': 200.0, 'u': 300.0}
    return {'version': 1, 'kind': 'gnss_series', 'status': 'success', 'data': {
        'station_uuid': station, 'station_name': '故障回归站', 'begin_time': begin, 'end_time': end,
        'timezone': 'Asia/Shanghai', 'total_points': 1, 'returned_points': 1, 'downsampled': False,
        'points': [point], 'summary': {'n': {'count': 1}, 'e': {'count': 1}, 'u': {'count': 1}, 'gaps': []},
        'features': {'n': {'count': 1}}, 'comparisons': {},
    }}


@tool(response_format='content_and_artifact')
async def observation() -> tuple[str, dict]:
    """取得一份隔离的位移证据。"""
    return '已取得位移观测', snapshot()


def run_async(function):
    return asyncio.run(function(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)


async def evidence_rows(storage, session):
    async with storage.pool.connection() as connection:
        cursor = await connection.execute('SELECT * FROM lma_evidence WHERE session_id=%s ORDER BY acquired_at', (session,))
        return await cursor.fetchall()


async def evidence_count(uri, session):
    async with connection_pool(uri) as pool:
        await pool.wait()
        return len(await evidence_rows(SessionStorage(pool), session))


@unittest.skipUnless(os.environ.get('LMA_TEST_DATABASE_URI'), '需配置隔离数据库')
class EvidenceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.uri = os.environ['LMA_TEST_DATABASE_URI']
        if not self.uri.endswith('/lma_test'):
            raise ValueError('只允许隔离lma_test数据库')

    def test_conclusion_index_survives_failure_after_tools_before_agent_finalization(self):
        from app.agent.evidence import EvidenceMiddleware

        async def fail_after_agent(self, state, runtime):
            raise RuntimeError('模拟工具已完成、Agent收尾之前发生故障')

        conclusions = AIMessage(id='ai-conclusions', content='故障回归站需人工复核。', tool_calls=[{
            'id': 'conclusions-1', 'name': 'record_conclusions', 'args': {'stations': [{
                'station_uuid': STATION, 'status': '需人工复核', 'reason': '北向持续变化',
                'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-02 00:00:00',
            }]},
        }])
        query = AIMessage(id='ai-query', content='', tool_calls=[{'id': 'observation-1', 'name': 'observation', 'args': {}}])

        async def scenario():
            await migrate_database(self.uri)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                await storage.create(session, '结论索引事务边界回归')
                saver = AsyncPostgresSaver(pool)
                try:
                    with patch.object(EvidenceMiddleware, 'aafter_agent', new=fail_after_agent):
                        agent = create_lma_agent(
                            ScriptedModel(script=[query, conclusions]),
                            agent_tools=[observation, record_conclusions], checkpointer=saver,
                            storage=storage, summary_model=ScriptedModel(script=[]),
                        )
                        with self.assertRaisesRegex(RuntimeError, 'Agent收尾之前'):
                            await agent.ainvoke(
                                {'messages': [HumanMessage(content='复核并留档')]},
                                {'configurable': {'thread_id': session}},
                            )
                    evidence = await evidence_rows(storage, session)
                    self.assertEqual([item['snapshot']['kind'] for item in evidence], ['gnss_series', 'conclusions'])
                    indexed = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                    self.assertEqual([(item['station_uuid'], item['status']) for item in indexed], [(STATION, '需人工复核')])

                    # 模拟只剩官方checkpoint的结论：对账补存时，结论与索引一起恢复，重复对账不重复写入。
                    state = await agent.aget_state({'configurable': {'thread_id': session}})
                    async with pool.connection() as connection:
                        async with connection.transaction():
                            await connection.execute(
                                'DELETE FROM lma_evidence WHERE session_id=%s AND tool_call_id=%s', (session, 'conclusions-1'),
                            )
                            await connection.execute('DELETE FROM lma_station_results WHERE session_id=%s', (session,))
                    await reconcile_evidence(storage, session, state.values['messages'])
                    await reconcile_evidence(storage, session, state.values['messages'])
                    restored = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                    self.assertEqual(len(restored), 1)
                    self.assertEqual(len(await evidence_rows(storage, session)), len(evidence))
                    history = await storage.station_history(STATION)
                    self.assertEqual(history['conclusions'][0]['status'], '需人工复核')
                    self.assertEqual(history['conclusions'][0]['begin_time'], '2026-11-01 00:00:00')
                finally:
                    await storage.delete(session)
                    await saver.adelete_thread(session)
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
                                if '已取得位移观测' in line:
                                    break
                            while not await evidence_count(self.uri, session):
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
                    self.assertEqual(results[0]['artifact']['kind'], 'gnss_series')
                    self.assertEqual(await evidence_count(self.uri, session), 1)
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
                    evidence = await evidence_rows(storage, session)
                    self.assertEqual(len(evidence), 1)
                    model = ScriptedModel(script=[AIMessage(content='根据已取得证据继续解释')])
                    agent = create_lma_agent(model, agent_tools=[observation], checkpointer=saver,
                                             storage=storage, summary_model=ScriptedModel(script=[]))
                    config = {'configurable': {'thread_id': session}}
                    state = await agent.aget_state(config)
                    recovered = await reconcile_evidence(storage, session, state.values['messages'])
                    self.assertEqual(len(recovered), 1)
                    self.assertEqual(recovered[0].artifact, evidence[0]['snapshot'])
                    config = await agent.aupdate_state(state.config, {'messages': recovered}, as_node='tools')
                    with patch(__name__ + '.observation.coroutine', side_effect=AssertionError('不得重放已取得的观测')):
                        result = await agent.ainvoke({'messages': [HumanMessage(content='解释原证据')]}, config)
                    self.assertIn('根据已取得证据', result['messages'][-1].text)
                    self.assertEqual(len(await evidence_rows(storage, session)), 1)
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
                    self.assertEqual(len(await evidence_rows(storage, session)), 1)
                    refresh = await storage.save_evidence(session, 'observation', snapshot(), execution_id='refresh')
                    self.assertNotEqual(str(refresh['id']), first[0].additional_kwargs['lma_evidence_uuid'])
                    self.assertEqual(len(await evidence_rows(storage, session)), 2)
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
                    self.assertEqual(len(await evidence_rows(storage, session)), 1)
                    with patch.object(storage, 'save_evidence', side_effect=OSError('隔离故障注入')):
                        with self.assertRaises(OSError):
                            await _commit_completed(storage, session, 'uncommitted', message)
                    self.assertIsNone(await storage.executed_evidence(session, 'uncommitted', message.tool_call_id))
                finally:
                    await storage.delete(session)
        run_async(scenario)
