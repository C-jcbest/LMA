"""按需记录复杂调查；通过 ToolRuntime 的会话标识约束访问。"""
import json
from datetime import datetime
from types import SimpleNamespace
from typing import Annotated, Literal
from uuid import UUID, uuid4

from langchain.tools import ToolRuntime, tool
from pydantic import Field

from app.server.investigation_models import InvestigationProgress, InvestigationTarget
from app.agent.tool_protocol import ToolFailure
from app.agent.tool_protocol import tool_result
from app.agent.numerical import common_period_features, window_features, numerical_model_data
from app.observations import normalize_observations, observation_quality
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
        references = {}
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
            series[station_uuid], cleaning = normalize_observations(series[station_uuid], begin_time, end_time)
            references[station_uuid] = data.get('reference', {})
            station_names[station_uuid] = data['station_name']
            sources.append({'evidence_uuid': str(identifier), 'acquired_at': str(record['acquired_at'])})
        cadence = 24.0 if sampling == 'daily' else 1.0
        common = {axis: common_period_features(series, axis, cadence_hours=cadence) for axis in ('n', 'e', 'u')}
        primary = next(iter(series))
        coordinates = references[primary].get('coordinates_m', {})
        station = SimpleNamespace(station_uuid=primary, **{f'station_{axis}0': coordinates.get(axis) for axis in ('n', 'e', 'u')})
        result = {
            'station_uuid': primary, 'station_name': station_names[primary],
            'begin_time': begin_time, 'end_time': end_time, 'sampling': sampling,
            'features': window_features(series[primary], station, begin_time, end_time, cadence),
            'quality': observation_quality(series[primary], begin_time, end_time, sample_times=['15:00'] if sampling == 'daily' else None),
            'reference': references[primary],
            'comparisons': {'common_period': common, 'station_names': station_names, 'sources': sources},
        }
        display = {**result, 'points': [
            {'time': point.data_time, 'n': point.n, 'e': point.e, 'u': point.u} for point in series[primary]
        ]}
        display['comparisons'] = {**result['comparisons'], 'snapshots': {
            station: [{'time': point.data_time, 'n': point.n, 'e': point.e, 'u': point.u} for point in points]
            for station, points in series.items()
        }}
        return tool_result(numerical_model_data(result), kind='numerical', display=display, observed_at=business_now().isoformat(),
                           limitations=['基于原快照重新计算，不代表当前观测；原获取时间保留于sources，不证明同组或共同成因'])

    @tool
    async def start_investigation(goal: str, targets: list[InvestigationTarget], runtime: ToolRuntime) -> str:
        """复杂调查按需建立目标。每个目标说明UUID、窗口、问题和需要的证据类型；简单问答无需建立。"""
        if any(target.outcome != 'pending' or target.evidence_ids for target in targets):
            raise ToolFailure("新调查从待调查目标开始；取得证据后按目标记录结果")
        progress = InvestigationProgress(goal=goal, targets=targets, unresolved=[target.question for target in targets])
        session_id = runtime.config['configurable']['thread_id']
        identifier = str(uuid4())
        record = await storage.save_progress(session_id, identifier, progress.model_dump(mode='json'))
        return json.dumps(record, ensure_ascii=False, default=str)

    @tool
    async def record_target_result(investigation_id: UUID, target_id: str, outcome: Literal['answered', 'insufficient', 'blocked'],
                                   result: str, evidence_ids: list[UUID], revision: int, runtime: ToolRuntime) -> str:
        """按目标记录已回答、证据不足或外部阻塞；不搬运整份进度。版本冲突时读最新状态再提交。"""
        try:
            record = await storage.update_target(runtime.config['configurable']['thread_id'], str(investigation_id), target_id,
                                                 outcome=outcome, result=result, evidence_ids=[str(value) for value in evidence_ids],
                                                 expected_revision=revision)
        except ValueError as exc:
            raise ToolFailure(str(exc)) from exc
        return json.dumps(record, ensure_ascii=False, default=str)

    @tool
    async def add_investigation_targets(investigation_id: UUID, targets: list[InvestigationTarget], reason: str,
                                        source: Literal['user_request', 'analysis'], revision: int, runtime: ToolRuntime) -> str:
        """增加新问题或新站，保留原目标；记录用户需求或分析发现、原因和本轮消息出处。"""
        user = next(message for message in reversed(runtime.state['messages']) if message.type == 'human')
        if not reason.strip() or any(target.outcome != 'pending' for target in targets):
            raise ToolFailure("新增目标须有调整原因，且从待调查状态开始")
        try:
            record = await storage.revise_targets(runtime.config['configurable']['thread_id'], str(investigation_id),
                                                  [target.model_dump(mode='json') for target in targets], reason=reason,
                                                  source=source, message_id=user.id, expected_revision=revision)
        except ValueError as exc:
            raise ToolFailure(str(exc)) from exc
        return json.dumps(record, ensure_ascii=False, default=str)

    @tool
    async def withdraw_investigation_target(investigation_id: UUID, target_id: str, reason: str,
                                            source: Literal['user_request', 'analysis'], revision: int, runtime: ToolRuntime) -> str:
        """明确撤回一个目标，保留原问题、结果和范围变更原因；不得用撤回来伪装问题已回答。"""
        if not reason.strip():
            raise ToolFailure("撤回目标须说明原因")
        user = next(message for message in reversed(runtime.state['messages']) if message.type == 'human')
        try:
            record = await storage.withdraw_target(runtime.config['configurable']['thread_id'], str(investigation_id), target_id,
                                                   reason=reason, source=source, message_id=user.id, expected_revision=revision)
        except ValueError as exc:
            raise ToolFailure(str(exc)) from exc
        return json.dumps(record, ensure_ascii=False, default=str)

    @tool
    async def finish_investigation(investigation_id: UUID, conclusion: str, revision: int, runtime: ToolRuntime) -> str:
        """结束目标已逐项处理的调查；允许如实交付不足或阻塞，执行结束不代表测点稳定。"""
        try:
            record = await storage.finish_investigation(runtime.config['configurable']['thread_id'], str(investigation_id), conclusion, revision)
        except ValueError as exc:
            raise ToolFailure(str(exc)) from exc
        return json.dumps(record, ensure_ascii=False, default=str)

    @tool
    async def read_investigation_record(investigation_id: UUID, runtime: ToolRuntime, offset: int = 0) -> str:
        """读取原调查及不可变证据快照。历史解释复用原证据；当前问题需另行查询刷新，保留旧证据。仅在用户明确要求续查后执行剩余目标。"""
        session_id = runtime.config['configurable']['thread_id']
        record = await storage.investigation(session_id, str(investigation_id))
        if record is None:
            raise ToolFailure("当前会话不存在该调查")
        if offset < 0:
            raise ToolFailure("目录页码偏移不能为负")
        catalog = await storage.evidence_catalog(session_id, investigation_id=str(investigation_id), offset=offset)
        remaining = [target for target in record['progress']['targets'] if target.get('outcome', 'pending') == 'pending']
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
            facts = {**snapshot, 'data': numerical_model_data(snapshot['data'])}
        return json.dumps({
            'reuse': str(evidence_uuid), 'original_acquired_at': str(record['acquired_at']),
            'snapshot': facts,
        }, ensure_ascii=False), snapshot

    return [start_investigation, record_target_result, add_investigation_targets, withdraw_investigation_target, finish_investigation, read_investigation_record, reuse_investigation_evidence, compare_investigation_evidence]
