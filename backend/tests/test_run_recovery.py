"""调查运行与官方 checkpoint 的故障边界，全部使用隔离数据库和生产 Agent 工厂。"""
import asyncio
import os
import socket
import subprocess
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.conclusions import record_conclusions
from app.agent.graph import LmaMiddleware, create_lma_agent
from app.agent.station_records import _finish_short_write
from app.server.api import commit_completed_tool_results
from app.server.storage import SessionStorage, connection_pool, migrate_database
from runtime_fixtures import ScriptedModel

STATION = '11111111-1111-1111-1111-111111111111'
BACKEND = str(Path(__file__).resolve().parents[1])
WORKER = str(Path(__file__).with_name('run_recovery_worker.py'))


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


def worker_env():
    return {**os.environ, 'PYTHONPATH': os.pathsep.join([BACKEND, str(Path(__file__).parent)])}


@unittest.skipUnless(os.environ.get('LMA_TEST_DATABASE_URI'), '需配置隔离数据库')
class RunRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.uri = os.environ['LMA_TEST_DATABASE_URI']
        if not self.uri.endswith('/lma_test'):
            raise ValueError('只允许隔离lma_test数据库')

    @asynccontextmanager
    async def isolated_storage(self, name):
        await migrate_database(self.uri)
        async with connection_pool(self.uri) as pool:
            await pool.wait()
            storage = SessionStorage(pool)
            session = str(uuid4())
            await storage.create(session, name)
            saver = AsyncPostgresSaver(pool)
            try:
                yield storage, session, saver
            finally:
                await storage.delete(session)
                await saver.adelete_thread(session)

    @asynccontextmanager
    async def served_api(self, slow_seconds):
        """真实 Uvicorn 进程与真实 HTTP 连接；测试结束清理会话。"""
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, WORKER, '--serve', str(port), str(slow_seconds)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=worker_env(),
        )
        sessions = []
        try:
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=10, trust_env=False) as client:
                async with asyncio.timeout(15):
                    while True:
                        if process.poll() is not None:
                            self.fail('隔离API服务提前退出')
                        try:
                            if (await client.get('/health')).status_code == 200:
                                break
                        except httpx.ConnectError:
                            pass
                        await asyncio.sleep(.05)
                yield client, sessions
        finally:
            process.terminate()
            await asyncio.to_thread(process.wait, timeout=10)
            async with connection_pool(self.uri) as pool:
                await pool.wait()
                for session in sessions:
                    await SessionStorage(pool).delete(session)
                    await AsyncPostgresSaver(pool).adelete_thread(session)

    async def start_and_disconnect(self, client, sessions):
        session = (await client.post('/sessions', json={'name': '运行恢复回归'})).json()['id']
        sessions.append(session)
        async with client.stream('POST', f'/sessions/{session}/runs', json={
            'messages': [{'type': 'human', 'id': str(uuid4()), 'content': '读取并行观测'}],
        }) as stream:
            self.assertEqual(stream.status_code, 200)
            async with asyncio.timeout(10):
                async for line in stream.aiter_lines():
                    if '已取得位移观测' in line:
                        break
        return session

    async def wait_finished(self, client, session):
        async with asyncio.timeout(15):
            while True:
                state = (await client.get(f'/sessions/{session}/state')).json()
                if state['latest_run']['status'] != 'running':
                    return state
                await asyncio.sleep(.05)

    def test_disconnect_keeps_running_and_rejoin_streams_the_rest(self):
        async def scenario():
            await migrate_database(self.uri)
            async with self.served_api(slow_seconds=1.5) as (client, sessions):
                session = await self.start_and_disconnect(client, sessions)
                async with client.stream('GET', f'/sessions/{session}/runs/active') as rejoined:
                    self.assertEqual(rejoined.status_code, 200)
                    body = ''
                    async with asyncio.timeout(15):
                        async for line in rejoined.aiter_lines():
                            body += line + '\n'
                self.assertIn('event: values', body)
                self.assertIn('较慢观测完成', body)
                self.assertIn('两项观测均已取得', body)
                state = await self.wait_finished(client, session)
                self.assertEqual(state['latest_run']['status'], 'success')
                results = [message['tool_call_id'] for message in state['values']['messages'] if message['type'] == 'tool']
                self.assertEqual(sorted(results), ['completed-observation', 'slow-observation'])
                self.assertEqual((await client.get(f'/sessions/{session}/runs/active')).status_code, 204)
        run_async(scenario)

    def test_cancel_keeps_completed_parallel_result_without_custom_store(self):
        async def scenario():
            await migrate_database(self.uri)
            async with self.served_api(slow_seconds=60) as (client, sessions):
                session = await self.start_and_disconnect(client, sessions)
                self.assertEqual((await client.post(f'/sessions/{session}/cancel')).status_code, 204)
                state = await self.wait_finished(client, session)
                self.assertEqual(state['latest_run']['status'], 'cancelled')
                results = [message for message in state['values']['messages'] if message['type'] == 'tool']
                self.assertEqual([message['tool_call_id'] for message in results], ['completed-observation'])
                self.assertEqual(results[0]['artifact']['kind'], 'gnss_series')
                refreshed = (await client.get(f'/sessions/{session}/state')).json()
                self.assertEqual(refreshed['values']['messages'], state['values']['messages'])
        run_async(scenario)

    def test_process_exit_recovers_completed_parallel_result_without_reexecuting(self):
        async def scenario():
            async with self.isolated_storage('进程故障回归') as (storage, session, saver):
                process = await asyncio.to_thread(
                    subprocess.run, [sys.executable, WORKER, session],
                    capture_output=True, timeout=30, env=worker_env(),
                )
                self.assertEqual(process.returncode, 73, process.stderr.decode('utf-8', errors='replace')[-2000:])
                agent = create_lma_agent(ScriptedModel(script=[]), agent_tools=[observation], checkpointer=saver,
                                         storage=storage, summary_model=ScriptedModel(script=[]))
                config = {'configurable': {'thread_id': session}}
                with patch(__name__ + '.observation.coroutine', side_effect=AssertionError('不得重放已取得的观测')):
                    state = await commit_completed_tool_results(agent, config)
                    again = await commit_completed_tool_results(agent, config)
                results = [message for message in state.values['messages'] if isinstance(message, ToolMessage)]
                self.assertEqual([message.tool_call_id for message in results], ['completed-observation'])
                self.assertEqual(results[0].artifact, snapshot())
                self.assertEqual(again.values['messages'], state.values['messages'])
        run_async(scenario)

    def test_conclusion_index_is_written_when_the_tool_completes(self):
        conclusions = AIMessage(id='ai-conclusions', content='故障回归站需人工复核。', tool_calls=[{
            'id': 'conclusions-1', 'name': 'record_conclusions', 'args': {'stations': [{
                'station_uuid': STATION, 'status': '需人工复核', 'reason': '北向持续变化',
                'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-02 00:00:00',
            }]},
        }])
        query = AIMessage(id='ai-query', content='', tool_calls=[{'id': 'observation-1', 'name': 'observation', 'args': {}}])

        async def fail_after_conclusions(self, state, runtime):
            if isinstance(state['messages'][-1], ToolMessage) and state['messages'][-1].name == 'record_conclusions':
                raise RuntimeError('模拟结论已登记、本轮收尾之前发生故障')

        async def scenario():
            async with self.isolated_storage('结论索引边界回归') as (storage, session, saver):
                with patch.object(LmaMiddleware, 'abefore_model', new=fail_after_conclusions):
                    agent = create_lma_agent(
                        ScriptedModel(script=[query, conclusions]),
                        agent_tools=[observation, record_conclusions], checkpointer=saver,
                        storage=storage, summary_model=ScriptedModel(script=[]),
                    )
                    with self.assertRaisesRegex(RuntimeError, '收尾之前'):
                        await agent.ainvoke(
                            {'messages': [HumanMessage(id='question-1', content='复核并留档')]},
                            {'configurable': {'thread_id': session}},
                        )
                indexed = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                self.assertEqual([(item['station_uuid'], item['status']) for item in indexed], [(STATION, '需人工复核')])
                history = await storage.station_history(STATION)
                self.assertEqual(history['conclusions'][0]['begin_time'], '2026-11-01 00:00:00')
                records = [row for row in await storage.station_records(STATION) if str(row['session_id']) == session]
                self.assertEqual([row['anchor_id'] for row in records], ['question-1'])
        run_async(scenario)

    def test_fork_prunes_conclusions_of_the_replaced_branch(self):
        async def scenario():
            async with self.isolated_storage('分叉清理回归') as (storage, session, _):
                stations = [{'station_uuid': STATION, 'station_name': '故障回归站', 'status': '持续关注',
                             'reason': '旧分支结论', 'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-02 00:00:00'}]
                await storage.save_conclusions(session, 'kept-call', stations)
                await storage.save_conclusions(session, 'replaced-call', [{**stations[0], 'status': '需人工复核'}])
                await storage.record_station_mentions(session, 'kept-question', '保留', {STATION: '故障回归站'})
                await storage.record_station_mentions(session, 'replaced-question', '替换', {STATION: '故障回归站'})
                await storage.prune_branch(session, tool_call_ids=['kept-call'], message_ids=['kept-question'])
                indexed = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                self.assertEqual([item['status'] for item in indexed], ['持续关注'])
                records = [row['anchor_id'] for row in await storage.station_records(STATION) if str(row['session_id']) == session]
                self.assertEqual(records, ['kept-question'])
        run_async(scenario)

    def test_cancelled_conclusion_write_still_finishes_and_storage_failure_is_visible(self):
        async def scenario():
            async with self.isolated_storage('取消写入回归') as (storage, session, _):
                stations = [{'station_uuid': STATION, 'station_name': '故障回归站', 'status': '持续关注',
                             'reason': '取消时仍写完', 'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-02 00:00:00'}]
                entered = asyncio.Event()

                async def delayed():
                    entered.set()
                    await asyncio.sleep(.05)
                    await storage.save_conclusions(session, 'cancelled-write', stations)

                write = asyncio.create_task(_finish_short_write(delayed()))
                await entered.wait()
                write.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await write
                indexed = [item for item in await storage.session_conclusions() if str(item['session_id']) == session]
                self.assertEqual(len(indexed), 1)

                async def failing():
                    raise OSError('隔离故障注入')

                with self.assertRaises(OSError):
                    await _finish_short_write(failing())
        run_async(scenario)
