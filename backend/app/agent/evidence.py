"""工具执行边界的幂等存证与checkpoint对账；不依赖HTTP流的消费。"""
import asyncio
from uuid import UUID

import anyio
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.business_time import business_now
from app.agent.artifacts import validate_artifact_envelope


def _origin(messages, tool_call_id):
    for message in reversed(messages):
        if isinstance(message, AIMessage) and any(call['id'] == tool_call_id for call in message.tool_calls):
            return str(message.id)
    raise ValueError('工具调用缺少对应的模型消息')


def _message_data(message):
    return message.model_dump(mode='json', exclude={'artifact'})


def _restored(record):
    metadata = record['message']
    if not metadata:
        return None
    return ToolMessage.model_validate({**metadata, 'artifact': record['snapshot'], 'additional_kwargs': {**metadata.get('additional_kwargs', {}), 'lma_evidence_uuid': str(record['id']), 'lma_execution_id': record['execution_id']}})


async def _commit_completed(storage, session_id, origin, message):
    async def commit():
        with anyio.fail_after(6, shield=True):
            return await storage.save_evidence(session_id, message.tool_call_id, message.artifact,
                                               execution_id=origin, message=_message_data(message))
    # 仅保护已完成结果的短写入，不屏蔽工具取数、模型调用或整轮调查的取消。
    task = asyncio.create_task(commit())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with anyio.CancelScope(shield=True):
            await asyncio.shield(task)
        raise


def _failure_artifact(request, result):
    args = request.tool_call['args']
    requested = args.get('station_name_or_uuid')
    if not requested:
        return None
    known = {}
    for message in request.state.get('messages', []):
        if isinstance(message, HumanMessage):
            focus = message.additional_kwargs.get('lma_context', {}).get('focus_identity')
            if focus:
                known[focus['station_uuid']] = focus['station_name']
        if not isinstance(message, ToolMessage) or not isinstance(message.artifact, dict):
            continue
        data = message.artifact.get('data', {})
        items = [data, data.get('center_station', {}), data.get('location', {}), *(data.get('stations') or [])]
        for item in items:
            if item.get('station_uuid') and item.get('station_name'):
                known[item['station_uuid']] = item['station_name']
    identifier = None
    try:
        identifier = str(UUID(requested))
    except ValueError:
        candidates = [identifier for identifier, name in known.items() if name == requested]
        if len(candidates) == 1:
            identifier = candidates[0]
    return validate_artifact_envelope({
        'version': 1, 'kind': 'acquisition_failure', 'status': 'error',
        'data': {'station_uuid': identifier, 'station_name': known.get(identifier, requested),
                 'begin_time': args.get('begin_time') or args.get('start_date'),
                 'end_time': args.get('end_time') or args.get('end_date'),
                 'message': result.text, 'requested_station': requested},
        'error': {'code': 'unavailable', 'category': 'business', 'message': result.text, 'retryable': False},
        'observedAt': business_now().isoformat(),
    })


class EvidenceMiddleware(AgentMiddleware):
    def __init__(self, storage):
        self.storage = storage

    async def aafter_agent(self, state, runtime):
        from app.agent.report import report_in_last_turn
        from app.server.investigations import investigation_record
        execution = runtime.execution_info
        session_id = execution.thread_id if execution is not None else None
        if session_id is None:
            return None
        messages = state.get('messages', [])
        report = report_in_last_turn(messages)
        if report is not None:
            await self.storage.record_conclusions(session_id, report[0], report[1]['stations'])
        record = investigation_record(messages)
        if record is not None:
            await self.storage.record_investigation(session_id, record)
        return None

    async def awrap_tool_call(self, request, handler):
        session_id = request.runtime.config.get('configurable', {}).get('thread_id')
        if session_id is None or request.tool_call['name'] == 'reuse_investigation_evidence':
            return await handler(request)
        origin = _origin(request.state.get('messages', []), request.tool_call['id'])
        previous = await self.storage.executed_evidence(session_id, origin, request.tool_call['id'])
        if previous is not None:
            restored = _restored(previous)
            if restored is not None:
                return restored
        result = await handler(request)
        if not isinstance(result, ToolMessage):
            return result
        if result.status == 'error' and result.artifact is None:
            artifact = _failure_artifact(request, result)
            if artifact is not None:
                result = result.model_copy(update={'artifact': artifact})
        if not isinstance(result.artifact, dict):
            return result
        record = await _commit_completed(self.storage, session_id, origin, result)
        return result.model_copy(update={'additional_kwargs': {
            **result.additional_kwargs, 'lma_evidence_uuid': str(record['id']), 'lma_execution_id': origin,
        }})


async def reconcile_evidence(storage, session_id, messages):
    """补存checkpoint已有结果，恢复存证成功但checkpoint未提交的并行结果；不重放取数。"""
    completed = {message.tool_call_id for message in messages if isinstance(message, ToolMessage)}
    recovered = []
    identifiers = [message.additional_kwargs['lma_evidence_uuid'] for message in messages
                   if isinstance(message, ToolMessage) and message.additional_kwargs.get('lma_evidence_uuid')]
    existing = await storage.existing_evidence_ids(session_id, identifiers)
    for index, message in enumerate(messages):
        if (isinstance(message, ToolMessage) and isinstance(message.artifact, dict) and message.name != 'reuse_investigation_evidence'
                and message.additional_kwargs.get('lma_evidence_uuid') not in existing):
            origin = _origin(messages[:index + 1], message.tool_call_id)
            record = await _commit_completed(storage, session_id, origin, message)
            if message.additional_kwargs.get('lma_evidence_uuid') != str(record['id']):
                recovered.append(message.model_copy(update={'additional_kwargs': {
                    **message.additional_kwargs, 'lma_evidence_uuid': str(record['id']), 'lma_execution_id': origin,
                }}))
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                if call['id'] in completed:
                    continue
                record = await storage.executed_evidence(session_id, str(message.id), call['id'])
                if record is not None:
                    restored = _restored(record)
                    if restored is not None:
                        recovered.append(restored)
    return recovered
