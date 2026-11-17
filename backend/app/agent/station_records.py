"""测点调查记录：工具完成时写入测点结论索引和“哪些会话调查过该测点”，不等 Agent 收尾。

工具结果本身只存于官方 checkpoint；这里写的是测点页、今日页和推荐使用的派生索引。
从历史 checkpoint 分叉时由接口层清理被替换分支的索引。
"""
import asyncio

import anyio
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage

from app.agent.conclusions import CONCLUSIONS_TOOL_NAME
from app.agent.station_evidence import evidence_by_station

_WRITE_TIMEOUT_SECONDS = 6


async def _finish_short_write(coroutine):
    """已完成的工具结果对应的短写入在停止调查时仍要写完；不屏蔽取数或模型调用本身的取消。"""
    async def write():
        with anyio.fail_after(_WRITE_TIMEOUT_SECONDS, shield=True):
            return await coroutine
    task = asyncio.create_task(write())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with anyio.CancelScope(shield=True):
            await asyncio.shield(task)
        raise


def _latest_question(messages) -> HumanMessage | None:
    return next((message for message in reversed(messages) if isinstance(message, HumanMessage)), None)


def _hook_session_id(runtime) -> str | None:
    execution = runtime.execution_info
    return execution.thread_id if execution is not None else None


def _tool_session_id(runtime) -> str | None:
    return runtime.config.get("configurable", {}).get("thread_id")


class StationRecordsMiddleware(AgentMiddleware):
    def __init__(self, storage):
        self.storage = storage

    async def abefore_agent(self, state, runtime):
        """从测点页提问时，即使本轮未取数也计入该测点的调查记录。"""
        session_id = _hook_session_id(runtime)
        question = _latest_question(state.get("messages", []))
        if session_id is None or question is None:
            return None
        focus = question.additional_kwargs.get("lma_context", {}).get("focus_identity")
        if focus:
            await _finish_short_write(self.storage.record_station_mentions(
                session_id, str(question.id), question.text[:300], {focus["station_uuid"]: focus["station_name"]},
            ))
        return None

    async def awrap_tool_call(self, request, handler):
        result = await handler(request)
        session_id = _tool_session_id(request.runtime)
        if session_id is None or not isinstance(result, ToolMessage) or not isinstance(result.artifact, dict):
            return result
        artifact = result.artifact
        if result.name == CONCLUSIONS_TOOL_NAME and artifact.get("status") == "success":
            await _finish_short_write(self.storage.save_conclusions(
                session_id, result.tool_call_id, artifact["data"]["stations"],
            ))
        question = _latest_question(request.state.get("messages", []))
        stations = {identifier: item.station_name for identifier, item in evidence_by_station([result]).items()}
        if question is not None and stations:
            await _finish_short_write(self.storage.record_station_mentions(
                session_id, str(question.id), question.text[:300], stations,
            ))
        return result
