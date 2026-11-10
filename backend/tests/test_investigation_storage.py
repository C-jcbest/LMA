"""只在隔离 lma_test 验证调查状态与不可变证据。"""
import asyncio
import json
import os
import sys
import unittest
from uuid import uuid4
from app.server.storage import connection_pool, migrate_database, SessionStorage
from app.agent.graph import create_lma_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from runtime_fixtures import ScriptedModel

class InvestigationStorageTests(unittest.TestCase):
    def test_immutable_evidence_and_lifecycle(self):
        uri = os.environ.get('LMA_TEST_DATABASE_URI', '')
        if not uri:
            self.skipTest('未配置隔离测试库')
        if not uri.endswith('/lma_test'):
            raise ValueError('只允许lma_test')
        async def scenario():
            await migrate_database(uri)
            async with connection_pool(uri) as pool:
                await pool.wait()
                storage = SessionStorage(pool)
                session = str(uuid4())
                identifier = str(uuid4())
                await storage.create(session, '调查回归')
                try:
                    station_uuid = str(uuid4())
                    await storage.save_evidence(session, 'old', {'value':1, 'kind':'numerical', 'status':'success', 'data': {
                        'station_uuid': station_uuid, 'begin_time':'2026-11-01 00:00:00', 'end_time':'2026-11-02 00:00:00',
                        'features': {'n': {'count':25}},
                    }})
                    await storage.save_evidence(session, 'old', {'value':99})
                    await storage.save_evidence(session, 'refresh', {'value':2})
                    evidence = await storage.evidence(session)
                    self.assertEqual([item['snapshot']['value'] for item in evidence], [1,2])
                    target = dict(target_id='A', station_uuid=station_uuid,
                                  begin_time='2026-11-01T00:00:00', end_time='2026-11-02T00:00:00',
                                  question='复核变化', outcome='answered', result='已复核', evidence_ids=[str(evidence[0]['id'])])
                    progress = dict(goal='复核两个测点', targets=[target, {**target, 'target_id':'B', 'outcome':'pending', 'evidence_ids':[]}],
                                    covered=['A'], unresolved=['B'], stage_conclusion='A已复核', status='running', end_reason='')
                    await storage.save_progress(session, identifier, progress)
                    with self.assertRaises(ValueError):
                        await storage.save_progress(session, identifier, {**progress, 'targets':[target]})
                    with self.assertRaises(ValueError):
                        await storage.save_progress(session, identifier, {**progress, 'status':'completed', 'unresolved':[]})
                    await storage.pause_investigations(session, 'budget', 'A已复核，B未覆盖')
                    record = await storage.investigation(session, identifier)
                    self.assertEqual(record['status'], 'paused')
                    self.assertEqual(record['progress']['unresolved'], ['B'])
                    self.assertNotIn('status', record['progress'])
                    model = ScriptedModel(script=[
                        AIMessage(content='', tool_calls=[{
                            'id':'read-progress', 'name':'read_investigation_record',
                            'args':{'investigation_id':identifier},
                        }]),
                        AIMessage(content='A已覆盖，接下来只调查B。'),
                    ])
                    agent = create_lma_agent(model, agent_tools=[], investigation_storage=storage,
                                             checkpointer=InMemorySaver(),
                                             summary_model=ScriptedModel(script=[]))
                    response = await agent.ainvoke(
                        {'messages':[
                            HumanMessage(content='原调查'),
                            AIMessage(content='', tool_calls=[{'id':'old','name':'original_evidence','args':{}}]),
                            ToolMessage(content='原观测', tool_call_id='old', artifact=evidence[0]['snapshot'],
                                        additional_kwargs={'lma_evidence_uuid': str(evidence[0]['id'])}),
                            HumanMessage(content='继续原调查，保留已完成范围'),
                        ]},
                        {'configurable':{'thread_id':session}},
                    )
                    projected = next(message for message in model.inputs[0] if isinstance(message, ToolMessage))
                    self.assertIn(f'<lma_persisted_evidence uuid="{evidence[0]["id"]}"/>', projected.content)
                    self.assertEqual(response['messages'][2].content, '原观测')
                    read_result = next(message for message in response['messages'] if isinstance(message, ToolMessage) and message.tool_call_id == 'read-progress')
                    restored = json.loads(read_result.content)
                    self.assertEqual([target['target_id'] for target in restored['remaining_targets']], ['B'])
                    self.assertEqual(restored['investigation']['progress']['covered'], ['A'])
                    self.assertNotIn('snapshot', restored['evidence']['items'][0])
                    self.assertEqual(len(await storage.evidence(session)), 2)
                    # 原快照可直接做共同时间比较，不为比较已覆盖对象再请求平台。
                    for call_id, station, hours in (('compare-A', station_uuid, (0, 1, 2)), ('compare-B', str(uuid4()), (1, 2, 3))):
                        await storage.save_evidence(session, call_id, {
                            'kind': 'numerical', 'status': 'success', 'data': {
                                'station_uuid': station, 'station_name': call_id, 'sampling': 'hourly',
                                'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-01 03:00:00',
                                'features': {}, 'comparisons': {},
                                'points': [{'time': f'2026-11-01 0{hour}:00:00', 'n': 100 + hour * .001, 'e': 200, 'u': 300} for hour in hours],
                            },
                        })
                    comparison_ids = [str(item['id']) for item in await storage.evidence(session) if item['tool_call_id'].startswith('compare-')]
                    model.script = [
                        AIMessage(content='', tool_calls=[{
                            'id': 'compare-saved', 'name': 'compare_investigation_evidence',
                            'args': {'evidence_uuids': comparison_ids, 'begin_time': '2026-11-01 00:00:00', 'end_time': '2026-11-01 03:00:00'},
                        }]),
                        AIMessage(content='共同有效时刻比较完成'),
                    ]
                    compared = await agent.ainvoke({'messages': [HumanMessage(content='比较原快照')]}, {'configurable': {'thread_id': session}})
                    comparison = next(message for message in compared['messages'] if isinstance(message, ToolMessage) and message.tool_call_id == 'compare-saved')
                    self.assertEqual(comparison.status, 'success', comparison.content)
                    data = comparison.artifact['data']
                    self.assertEqual({feature['count'] for feature in data['comparisons']['common_period']['n'].values()}, {2})
                    self.assertEqual(data['features']['n']['count'], 3)
                    self.assertAlmostEqual(data['features']['n']['net_change_mm'], 2)
                    self.assertEqual({source['evidence_uuid'] for source in data['comparisons']['sources']}, set(comparison_ids))
                    self.assertNotIn('snapshots', json.loads(comparison.content)['comparisons'])
                    record = await storage.investigation(session, identifier)
                    await storage.save_progress(session, identifier, progress, expected_revision=record['revision'])
                    await storage.interrupt_previous_runs()
                    self.assertEqual((await storage.investigation(session, identifier))['status'], 'interrupted')
                    record = await storage.investigation(session, identifier)
                    await storage.save_progress(session, identifier, progress, expected_revision=record['revision'])
                    await storage.pause_investigations(session, 'cancelled')
                    self.assertEqual((await storage.investigation(session, identifier))['status'], 'cancelled')
                    self.assertIsNone(await storage.investigation(str(uuid4()), identifier))
                finally:
                    await storage.delete(session)
        asyncio.run(scenario(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)
