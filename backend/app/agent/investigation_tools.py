"""按需记录复杂调查；通过 ToolRuntime 的会话标识约束访问。"""
import json
from datetime import datetime
from types import SimpleNamespace
from typing import Annotated
from uuid import UUID, uuid4

from langchain.tools import ToolRuntime, tool
from pydantic import Field

from app.server.investigation_models import InvestigationProgress
from app.agent.tool_protocol import ToolFailure
from app.agent.tool_protocol import tool_result
from app.agent.numerical import common_period_features
from app.business_time import TIME_FORMAT, business_now


def investigation_tools(storage):
    @tool(response_format="content_and_artifact")
    async def compare_investigation_evidence(
        evidence_uuids: Annotated[list[UUID], Field(min_length=2, max_length=9)],
        begin_time: str, end_time: str, runtime: ToolRuntime,
    ):
        """对当前会话已保存的不同测点数值证据做共同有效时段比较，不重新请求平台。

        续查比较已覆盖对象时优先复用已有快照；输入持久化UUID与上海时间窗YYYY-MM-DD HH:mm:ss。
        仅接受同采样粒度的数值快照，不推断同组关系或共同成因；当前状况仍需先核查快照新鲜度。
        """
        try:
            start = datetime.strptime(begin_time, TIME_FORMAT)
            end = datetime.strptime(end_time, TIME_FORMAT)
        except ValueError as exc:
            raise ToolFailure("比较时间必须为YYYY-MM-DD HH:mm:ss") from exc
        if start >= end:
            raise ToolFailure("比较窗口必须正向")
        session_id = runtime.config['configurable']['thread_id']
        series = {}
        station_names = {}
        sources = []
        sampling = None
        for identifier in evidence_uuids:
            record = await storage.evidence_item(session_id, str(identifier))
            if record is None:
                raise ToolFailure("证据不属于当前会话或不存在")
            snapshot = record['snapshot']
            if snapshot.get('kind') != 'numerical' or snapshot.get('status') != 'success':
                raise ToolFailure("仅可比较成功的独立数值证据")
            data = snapshot['data']
            if sampling is not None and sampling != data['sampling']:
                raise ToolFailure("比较证据必须具有相同采样粒度")
            sampling = data['sampling']
            station_uuid = data['station_uuid']
            if station_uuid in series:
                raise ToolFailure("每个测点只选择一个适用窗口快照")
            if begin_time < data['begin_time'] or end_time > data['end_time']:
                raise ToolFailure("比较窗口必须包含于每条原证据的查询窗口")
            series[station_uuid] = [
                SimpleNamespace(data_time=point['time'], n=point.get('n'), e=point.get('e'), u=point.get('u'))
                for point in data['points'] if begin_time <= point['time'] <= end_time
            ]
            station_names[station_uuid] = data['station_name']
            sources.append({'evidence_uuid': str(identifier), 'acquired_at': str(record['acquired_at'])})
        cadence = 24.0 if sampling == 'daily' else 1.0
        common = {axis: common_period_features(series, axis, cadence_hours=cadence) for axis in ('n', 'e', 'u')}
        primary = next(iter(series))
        result = {
            'station_uuid': primary, 'station_name': station_names[primary],
            'begin_time': begin_time, 'end_time': end_time, 'sampling': sampling,
            'features': {axis: common[axis][primary] for axis in common},
            'comparisons': {'common_period': common, 'station_names': station_names, 'sources': sources},
        }
        display = {**result, 'points': [
            {'time': point.data_time, 'n': point.n, 'e': point.e, 'u': point.u} for point in series[primary]
        ]}
        display['comparisons'] = {**result['comparisons'], 'snapshots': {
            station: [{'time': point.data_time, 'n': point.n, 'e': point.e, 'u': point.u} for point in points]
            for station, points in series.items()
        }}
        return tool_result(result, kind='numerical', display=display, observed_at=business_now().isoformat(),
                           limitations=['基于原快照重新计算，不代表当前观测；原获取时间保留于sources，不证明同组或共同成因'])

    @tool
    async def record_investigation_progress(
        progress: InvestigationProgress, runtime: ToolRuntime, investigation_id: UUID | None = None,
    ) -> str:
        """复杂调查按需记录目标、对象窗口、已覆盖、待解决及阶段结论。简单问答无需建记录。更新时使用原调查ID。"""
        session_id = runtime.config['configurable']['thread_id']
        identifier = str(investigation_id or uuid4())
        if investigation_id and await storage.investigation(session_id, identifier) is None:
            raise ToolFailure("当前会话不存在该调查")
        try:
            await storage.save_progress(session_id, identifier, progress.model_dump(mode='json'))
        except ValueError as exc:
            raise ToolFailure(str(exc)) from exc
        return json.dumps({
            'investigation_id': identifier, 'progress': progress.model_dump(mode='json'),
        }, ensure_ascii=False)

    @tool
    async def read_investigation_record(investigation_id: UUID, runtime: ToolRuntime) -> str:
        """读取原调查及不可变证据快照。历史解释复用原证据；当前问题需另行查询刷新，保留旧证据。仅在用户明确要求续查后执行剩余目标。"""
        session_id = runtime.config['configurable']['thread_id']
        record = await storage.investigation(session_id, str(investigation_id))
        if record is None:
            raise ToolFailure("当前会话不存在该调查")
        evidence = await storage.evidence(session_id)
        catalog = []
        for item in evidence:
            snapshot = item['snapshot']
            data = snapshot.get('data', {})
            station = data.get('center_station') or data.get('location') or data
            catalog.append({
                'evidence_id': str(item['id']), 'acquired_at': str(item['acquired_at']),
                'kind': snapshot.get('kind'), 'status': snapshot.get('status'),
                'station_uuid': station.get('station_uuid'), 'station_name': station.get('station_name'),
                'begin_time': data.get('begin_time'), 'end_time': data.get('end_time'),
                'limitations': snapshot.get('limitations', []),
            })
        covered = set(record['progress']['covered'])
        remaining = [target for target in record['progress']['targets'] if target['target_id'] not in covered]
        return json.dumps({
            'investigation': record, 'remaining_targets': remaining, 'evidence': catalog,
            'freshness': '根据每条证据获取时间和覆盖窗口核查当前问题适用性；不自动刷新或重放已覆盖对象',
        }, default=str, ensure_ascii=False)

    @tool(response_format="content_and_artifact")
    async def reuse_investigation_evidence(evidence_uuid: UUID, runtime: ToolRuntime):
        """显式复用当前会话原证据快照用于历史解释或比较；不刷新、不改变原获取时间。当前状况应另行查询。"""
        session_id = runtime.config['configurable']['thread_id']
        record = await storage.evidence_item(session_id, str(evidence_uuid))
        if record is None:
            raise ToolFailure("证据不属于当前会话或不存在")
        snapshot = record['snapshot']
        if snapshot.get('status') == 'error':
            raise ToolFailure("原证据包含未完成或失败的查询，不能作为成功证据复用；请查阅限制或重新取得数据")
        facts = snapshot
        if snapshot.get('kind') == 'numerical':
            data = snapshot['data']
            facts = {**snapshot, 'data': {key: value for key, value in data.items() if key != 'points'}}
            facts['data']['comparisons'] = {key: value for key, value in data.get('comparisons', {}).items() if key != 'snapshots'}
        return json.dumps({
            'reuse': str(evidence_uuid), 'original_acquired_at': str(record['acquired_at']),
            'snapshot': facts,
        }, ensure_ascii=False), snapshot

    return [record_investigation_progress, read_investigation_record, reuse_investigation_evidence, compare_investigation_evidence]
