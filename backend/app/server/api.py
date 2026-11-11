"""单进程自托管 API：会话目录、官方 checkpoint、运行取消与 SSE。"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Annotated, Literal
from uuid import UUID, uuid4
from weakref import WeakValueDictionary

import anyio
import httpx
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sse_starlette import EventSourceResponse

from app.agent.graph import _get_llm, create_lma_agent
from app.agent.report import report_in_last_turn
from app.agent.evidence import reconcile_evidence
from app.agent.title import generate_title_node
from app.agent.suggestions import suggest_questions
from app.agent.tools import _build_client
from app.beidou.client import BeidouApiError, station_catalog_scope
from app.config import Settings, get_settings
from app.inspection.runner import run_inspection
from app.server.messages import project_message, project_state
from app.server.investigations import investigation_record
from app.server.stations import TIMELINE_WINDOW_DAYS, find_station, load_station_series
from app.server.storage import SessionStorage, connection_pool

logger = logging.getLogger(__name__)


class ApiInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


SessionName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class SessionCreate(ApiInput):
    name: SessionName = "新会话"
    station_uuid: str | None = Field(default=None, min_length=1, max_length=200)


class SessionUpdate(ApiInput):
    name: SessionName | None = None
    archived: bool | None = None


class UserInput(ApiInput):
    type: Literal["human"]
    id: str = Field(min_length=1, max_length=200)
    content: str | list[dict]


class ToolCancellation(ApiInput):
    # assistant-ui 的官方 autoCancelPendingToolCalls 请求，不接受客户端工具成功结果。
    type: Literal["tool"]
    id: str | None = Field(default=None, max_length=200)
    name: str
    tool_call_id: str
    content: Literal['{"cancelled":true}']
    status: Literal["error"]


class RunInput(ApiInput):
    messages: list[Annotated[UserInput | ToolCancellation, Field(discriminator="type")]] = Field(
        default_factory=list, max_length=65,
    )
    checkpoint_id: str | None = Field(default=None, max_length=200)
    # 用户提问时正在查看的测点；只作为模型可见的上下文，不改变消息正文。
    focus_station: str | None = Field(default=None, min_length=1, max_length=100)
    focus_station_uuid: UUID | None = None
    resume_investigation_id: UUID | None = None


class CheckpointInput(ApiInput):
    message_ids: list[str] = Field(max_length=10000)


class TitleInput(ApiInput):
    input_text: str = Field(min_length=1, max_length=100000)


@dataclass
class ActiveRun:
    id: str
    cancel_scope: anyio.CancelScope | None = None
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    stop_requested: bool = False


def graph_config(session_id: str, checkpoint_id: str | None = None) -> dict:
    configurable = {"thread_id": session_id}
    if checkpoint_id is not None:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


def prepare_messages(body: RunInput, snapshot, latest_run: dict | None) -> list:
    """校验用户输入和官方取消请求；从不信任前端提供的工具结果。"""
    stored_messages = snapshot.values.get("messages", [])
    pending_calls = {}
    completed_calls = set()
    known_calls = {}
    for message in stored_messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                pending_calls[call["id"]] = call
                known_calls[call["id"]] = call
        elif isinstance(message, ToolMessage):
            pending_calls.pop(message.tool_call_id, None)
            completed_calls.add(message.tool_call_id)

    users = [message for message in body.messages if isinstance(message, UserInput)]
    cancellations = [message for message in body.messages if isinstance(message, ToolCancellation)]
    if len(users) > 1 or (not users and body.checkpoint_id is None):
        raise HTTPException(422, "每次提交一条用户消息；重新生成必须指定 checkpoint。")
    if users and not users[0].content:
        raise HTTPException(422, "消息不能为空。")

    cancelled_ids = set()
    accepted = []
    for cancellation in cancellations:
        call = known_calls.get(cancellation.tool_call_id)
        if call is None or call["name"] != cancellation.name:
            raise HTTPException(422, "取消请求与服务端工具调用不匹配。")
        if cancellation.tool_call_id in completed_calls:
            # 停止与工具完成可能同时发生；真实结果已经提交时，不用取消请求覆盖它。
            continue
        if latest_run is None or latest_run["status"] not in {"cancelled", "interrupted", "error"}:
            raise HTTPException(409, "当前工具调用尚未停止。")
        if cancellation.tool_call_id in cancelled_ids:
            raise HTTPException(422, "工具取消请求重复。")
        cancelled_ids.add(cancellation.tool_call_id)
        accepted.append(ToolMessage(
            id=str(uuid4()), name=call["name"], tool_call_id=call["id"],
            content="上轮运行已停止，此工具调用没有返回结果。", status="error", artifact=None,
        ))
    if set(pending_calls) != cancelled_ids:
        raise HTTPException(409, "上轮有未完成的工具调用，请重新载入会话后提交。")
    for user in users:
        focus = {"lma_focus_station": body.focus_station} if body.focus_station else {}
        accepted.append(HumanMessage(id=user.id, content=user.content, additional_kwargs=focus))
    return accepted


def create_app(settings: Settings | None = None, agent_factory=None, inspection_client_factory=None) -> FastAPI:
    settings = settings or get_settings()
    active_runs: dict[str, ActiveRun] = {}
    state_locks = WeakValueDictionary()
    active_inspections: set[asyncio.Task] = set()
    inspection_start_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with connection_pool(settings.database_uri, settings.database_pool_size) as pool:
            await pool.wait()
            storage = SessionStorage(pool)
            # 本服务固定一个 worker；进程终止的 Run 显式标记中断，不自动重放外部请求。
            await storage.interrupt_previous_runs()
            checkpointer = AsyncPostgresSaver(pool)
            factory = agent_factory or (lambda saver, records: create_lma_agent(_get_llm(), checkpointer=saver, investigation_storage=records))
            app.state.agent = factory(checkpointer, storage)
            app.state.storage = storage
            app.state.checkpointer = checkpointer
            try:
                yield
            finally:
                for inspection in active_inspections:
                    inspection.cancel()
                if active_inspections:
                    await asyncio.gather(*active_inspections, return_exceptions=True)
                runs = list(active_runs.values())
                for run in runs:
                    run.stop_requested = True
                    if run.cancel_scope is not None:
                        run.cancel_scope.cancel()
                if runs:
                    await asyncio.gather(*(run.finished.wait() for run in runs))

    app = FastAPI(title="LMA 自托管 API", lifespan=lifespan)
    origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"],
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        # Pydantic 原始错误包含用户输入，不能将其整包回传或写日志。
        return JSONResponse(status_code=422, content={"detail": "请求参数不符合接口要求。"})

    @app.exception_handler(Exception)
    async def server_error(request: Request, error: Exception):
        logger.error("self-hosted API failed", exc_info=error)
        return JSONResponse(status_code=500, content={"detail": "服务处理失败，请稍后重试。"})

    async def require_session(session_id: UUID) -> dict:
        session = await app.state.storage.get(str(session_id))
        if session is None:
            raise HTTPException(404, "会话不存在。")
        return session

    def require_idle(session_id: UUID) -> None:
        if str(session_id) in active_runs:
            raise HTTPException(409, "当前会话仍在运行，请停止后再操作。")

    @app.get("/health")
    async def health():
        async with app.state.storage.pool.connection() as connection:
            await connection.execute("SELECT 1")
        return {"ok": True, "service": "lma"}

    @app.get("/sessions")
    async def list_sessions(
        limit: int = Query(21, ge=1, le=100), offset: int = Query(0, ge=0),
        station_uuid: str | None = Query(None, min_length=1, max_length=200),
    ):
        return await app.state.storage.list(limit, offset, station_uuid)

    @app.get("/sessions/conclusions")
    async def list_session_conclusions():
        return await app.state.storage.session_conclusions()

    @app.post("/sessions", status_code=201)
    async def create_session(body: SessionCreate):
        return await app.state.storage.create(str(uuid4()), body.name, body.station_uuid)

    @app.get("/sessions/{session_id}")
    async def get_session(session_id: UUID):
        return await require_session(session_id)

    @app.patch("/sessions/{session_id}")
    async def update_session(session_id: UUID, body: SessionUpdate):
        await require_session(session_id)
        require_idle(session_id)
        return await app.state.storage.update(str(session_id), body.name, body.archived)

    @app.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: UUID):
        await require_session(session_id)
        require_idle(session_id)
        await app.state.checkpointer.adelete_thread(str(session_id))
        await app.state.storage.delete(str(session_id))
        return Response(status_code=204)

    async def reconciled_state(session_id, config):
        async with state_locks.setdefault(session_id, asyncio.Lock()):
            snapshot = await app.state.agent.aget_state(config)
            if session_id not in active_runs:
                recovered = await reconcile_evidence(app.state.storage, session_id, snapshot.values.get("messages", []))
                if recovered:
                    config = await app.state.agent.aupdate_state(snapshot.config, {"messages": recovered}, as_node="tools")
                    snapshot = await app.state.agent.aget_state(config)
            return snapshot

    @app.get("/sessions/{session_id}/state")
    async def get_state(session_id: UUID):
        await require_session(session_id)
        snapshot = await reconciled_state(str(session_id), graph_config(str(session_id)))
        return {
            "values": project_state(snapshot.values),
            "latest_run": await app.state.storage.latest_run(str(session_id)),
        }

    @app.get("/sessions/{session_id}/investigations")
    async def list_investigations(session_id: UUID):
        await require_session(session_id)
        return await app.state.storage.investigations(str(session_id))

    @app.get("/sessions/{session_id}/evidence")
    async def list_evidence(session_id: UUID, limit: int = Query(30, ge=1, le=100), offset: int = Query(0, ge=0), investigation_id: UUID | None = None):
        await require_session(session_id)
        return await app.state.storage.evidence_catalog(str(session_id), limit=limit, offset=offset, investigation_id=str(investigation_id) if investigation_id else None)

    @app.get("/sessions/{session_id}/evidence/{evidence_id}")
    async def evidence_detail(session_id: UUID, evidence_id: UUID):
        await require_session(session_id)
        item = await app.state.storage.evidence_item(str(session_id), str(evidence_id))
        if item is None:
            raise HTTPException(404, "证据不存在。")
        return item

    @app.post("/sessions/{session_id}/investigations/{investigation_id}/resume")
    async def resume_investigation(session_id: UUID, investigation_id: UUID):
        await require_session(session_id)
        require_idle(session_id)
        record = await app.state.storage.investigation(str(session_id), str(investigation_id))
        if record is None:
            raise HTTPException(404, "调查不存在")
        if record["status"] == "completed":
            raise HTTPException(409, "调查已完成；当前问题应新建调查")
        return await stream_run(session_id, RunInput(
            messages=[UserInput(type="human", id=str(uuid4()), content="继续调查")], resume_investigation_id=investigation_id,
        ))

    @app.post("/sessions/{session_id}/checkpoint")
    async def find_checkpoint(session_id: UUID, body: CheckpointInput):
        await require_session(session_id)
        require_idle(session_id)
        async for snapshot in app.state.agent.aget_state_history(graph_config(str(session_id))):
            ids = [message.id for message in snapshot.values.get("messages", [])]
            if ids == body.message_ids:
                return {"checkpoint_id": snapshot.config["configurable"]["checkpoint_id"]}
        raise HTTPException(409, "找不到对应的历史 checkpoint，请重新载入会话。")

    @app.get("/inspections/latest")
    async def latest_inspection():
        return await app.state.storage.latest_inspection()

    @app.post("/inspections", status_code=202)
    async def start_inspection():
        async with inspection_start_lock:
            if active_inspections:
                raise HTTPException(409, "巡检正在进行，请等待完成。")
            inspection_id = str(uuid4())
            await app.state.storage.start_inspection(inspection_id)
            task = asyncio.create_task(run_inspection(
                app.state.storage, inspection_id, inspection_client_factory or _build_client,
            ))
            active_inspections.add(task)
            task.add_done_callback(active_inspections.discard)
        return {"id": inspection_id}

    @app.get("/stations")
    async def station_directory():
        try:
            async with (inspection_client_factory or _build_client)() as client:
                stations = await client.get_stations()
                return [
                    {
                        "station_uuid": station.station_uuid,
                        "station_name": station.station_name,
                        "group_name": station.group_name,
                    }
                    for station in stations
                ]
        except (BeidouApiError, httpx.HTTPError):
            logger.warning("station directory request failed", exc_info=True)
            raise HTTPException(502, "测点列表尚未载入。") from None

    @app.get("/stations/{station_uuid}/timeline")
    async def station_timeline(station_uuid: str, days: int = 90):
        if days not in TIMELINE_WINDOW_DAYS:
            raise HTTPException(422, "请求参数不符合接口要求。")
        try:
            async with (inspection_client_factory or _build_client)() as client:
                station = await find_station(client, station_uuid)
                if station is None:
                    raise HTTPException(404, "测点不存在。")
                series = await load_station_series(client, station, days)
        except (BeidouApiError, httpx.HTTPError):
            # 原始错误可能带上游地址和账号信息，只进日志。
            logger.warning("station timeline request failed", exc_info=True)
            raise HTTPException(502, "监测平台数据暂不可用，请稍后重试。") from None
        return {
            "station_uuid": station.station_uuid,
            "station_name": station.station_name,
            "group_name": station.group_name,
            "series": series,
            "records": await app.state.storage.station_records(station.station_uuid),
        }

    @app.post("/suggestions")
    async def generate_suggestions():
        try:
            async with asyncio.timeout(15):
                inspection = await app.state.storage.latest_inspection()
                return {"questions": await suggest_questions(inspection)}
        except Exception:
            logger.warning("question suggestions unavailable", exc_info=True)
            return {"questions": []}

    @app.post("/title")
    async def generate_title(body: TitleInput):
        try:
            return await asyncio.wait_for(generate_title_node({"input_text": body.input_text}), timeout=15)
        except Exception:
            logger.warning("session title generation failed", exc_info=True)
            raise HTTPException(502, "会话标题生成失败。") from None

    @app.post("/sessions/{session_id}/cancel", status_code=204)
    async def cancel_run(session_id: UUID):
        await require_session(session_id)
        run = active_runs.get(str(session_id))
        if run is not None:
            run.stop_requested = True
            if run.cancel_scope is not None:
                run.cancel_scope.cancel()
            await asyncio.wait_for(run.finished.wait(), timeout=30)
        return Response(status_code=204)

    @app.post("/sessions/{session_id}/runs")
    async def stream_run(session_id: UUID, body: RunInput):
        session = await require_session(session_id)
        require_idle(session_id)
        key = str(session_id)
        config = graph_config(key, body.checkpoint_id)
        async with state_locks.setdefault(key, asyncio.Lock()):
            require_idle(session_id)
            snapshot = await app.state.agent.aget_state(config)
            recovered = await reconcile_evidence(app.state.storage, key, snapshot.values.get("messages", []))
            if recovered:
                config = await app.state.agent.aupdate_state(snapshot.config, {"messages": recovered}, as_node="tools")
                snapshot = await app.state.agent.aget_state(config)
            control = ActiveRun(id=str(uuid4()))
            active_runs[key] = control
        config = snapshot.config if snapshot.created_at else config
        config = {**config, "run_id": control.id}
        try:
            if body.checkpoint_id is not None and not snapshot.created_at:
                raise HTTPException(404, "checkpoint 不存在。")
            latest_run = await app.state.storage.latest_run(key)
            messages = prepare_messages(body, snapshot, latest_run)
            if body.focus_station_uuid is not None and session.get("station_uuid") != str(body.focus_station_uuid):
                raise HTTPException(422, "当前测点与会话归属不一致。")
            if body.resume_investigation_id is not None:
                record = await app.state.storage.investigation(key, str(body.resume_investigation_id))
                if record is None:
                    raise HTTPException(404, "调查不存在。")
                if record["status"] == "completed":
                    raise HTTPException(409, "调查已完成；当前问题应建立新目标。")
            for message in messages:
                if isinstance(message, HumanMessage):
                    if body.resume_investigation_id is not None:
                        if message.text != "继续调查":
                            raise HTTPException(422, "续查操作与消息不匹配。")
                        message.additional_kwargs["lma_resume_investigation_id"] = str(body.resume_investigation_id)
                    if body.focus_station and session.get("station_uuid"):
                        message.additional_kwargs["lma_focus_identity"] = {"station_uuid": session["station_uuid"], "station_name": body.focus_station}
            if any(isinstance(message, ToolCancellation) for message in body.messages):
                # 并行 ToolNode 被停止时，已完成工具可能仍在 pending writes 中。
                # 用官方 update_state 提交这些真实结果及用户的取消确认，避免新输入丢弃 pending writes。
                tool_results = [message for message in messages if isinstance(message, ToolMessage)]
                config = await app.state.agent.aupdate_state(
                    snapshot.config, {"messages": [*snapshot.values.get("messages", []), *tool_results]},
                    as_node="tools",
                )
                messages = [message for message in messages if isinstance(message, HumanMessage)]
            await app.state.storage.start_run(key, control.id)
        except BaseException:
            active_runs.pop(key, None)
            raise

        async def events():
            # 客户端断开也可能直接关闭生成器；只有图完整结束才记录成功。
            status = "cancelled"
            final_values = None
            try:
                with anyio.CancelScope() as cancel_scope, station_catalog_scope():
                    control.cancel_scope = cancel_scope
                    if control.stop_requested:
                        return
                    yield {"event": "metadata", "data": json.dumps({"run_id": control.id})}
                    graph_input = {"messages": messages} if messages else None
                    async for mode, data in app.state.agent.astream(
                        graph_input, config, stream_mode=["messages", "values"], durability="sync",
                    ):
                        if mode == "messages":
                            message, metadata = data
                            payload = [project_message(message), {
                                "langgraph_node": metadata.get("langgraph_node"),
                            }]
                        else:
                            final_values = data
                            payload = project_state(data)
                        yield {"event": mode, "data": json.dumps(jsonable_encoder(payload), ensure_ascii=False)}
                    status = "success"
            except asyncio.CancelledError:
                status = "cancelled"
                raise
            except Exception:
                status = "error"
                logger.exception("agent run failed: %s", control.id)
                yield {"event": "error", "data": json.dumps({
                    "message": "本轮运行失败，已保存完成的步骤，请重新载入会话后重试。",
                }, ensure_ascii=False)}
            finally:
                with anyio.CancelScope(shield=True):
                    try:
                        report = report_in_last_turn(final_values["messages"]) if status == "success" and final_values else None
                        stage_conclusion = ""
                        reason = status
                        if final_values:
                            turn_messages = final_values.get("messages", [])
                            last_user = next((index for index in range(len(turn_messages) - 1, -1, -1)
                                              if isinstance(turn_messages[index], HumanMessage)), -1)
                            answers = [message for message in turn_messages[last_user + 1:]
                                       if isinstance(message, AIMessage) and not message.tool_calls]
                            if answers:
                                stage_conclusion = answers[-1].text[:3000]
                            if report is not None:
                                stage_conclusion = report[1]["conclusion"]
                            if any(message.additional_kwargs.get('lma_budget_exhausted') for message in answers):
                                reason = "budget"
                        await app.state.storage.pause_investigations(key, reason, stage_conclusion)
                        await app.state.storage.finish_run(control.id, status)
                    finally:
                        active_runs.pop(key, None)
                        control.finished.set()

        return EventSourceResponse(events(), ping=15, send_timeout=30)

    return app


app = create_app()
