"""单进程自托管 API：会话目录、官方 checkpoint、运行取消与 SSE。"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Annotated, Callable, Literal
from uuid import UUID, uuid4
from weakref import WeakValueDictionary

import anyio
import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sse_starlette import EventSourceResponse

from app.agent.graph import _get_llm, create_lma_agent
from app.agent.message_context import ASK_TARGETS_KEY
from app.agent.title import generate_title
from app.agent.suggestions import SuggestionService
from app.beidou.client import BeidouApiError
from app.business_time import BUSINESS_TZ, business_now
from app.config import Settings, get_settings
from app.observability import AgentTracing
from app.inspection.lab import SUMMARY_COMPONENT, build_lab_graph, stations_in_scope
from app.inspection.runner import run_inspection
from app.monitoring_data import (
    STATION_STATUS_TEXT,
    STATION_TYPE_TEXT,
    build_platform_client,
    monitoring_scope,
    station_coordinates,
)
from app.rainfall import daily_rainfall, heavy_rain_events, rainfall_payload, with_displacement_rates
from app.server.auth import auth_enabled, auth_router, require_login
from app.server.messages import project_message, project_state
from app.server.stations import TimelineWindow, find_station, load_station_series, timeline_window
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
    type: Literal["tool"]
    id: str | None = Field(default=None, max_length=200)
    name: str
    tool_call_id: str
    content: Literal['{"cancelled":true}']
    status: Literal["error"]


class AskTarget(ApiInput):
    """用户在图表上选中、要追问的测点时间段；作为结构化上下文随消息保存，不写进正文。"""
    station_uuid: UUID | None = None
    kind: Literal["displacement", "rainfall"] | None = None
    evidence_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    station_name: str = Field(min_length=1, max_length=100)
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def check_range(self):
        if self.station_uuid is None and self.kind != "rainfall":
            raise ValueError("位移追问需要指定测点。")
        if self.start >= self.end:
            raise ValueError("追问时间段的开始必须早于结束。")
        return self


class RunInput(ApiInput):
    messages: list[Annotated[UserInput | ToolCancellation, Field(discriminator="type")]] = Field(
        default_factory=list, max_length=65,
    )
    checkpoint_id: str | None = Field(default=None, max_length=200)
    focus_station: str | None = Field(default=None, min_length=1, max_length=100)
    focus_station_uuid: UUID | None = None
    ask_targets: list[AskTarget] = Field(default_factory=list, max_length=4)


class LabScopeInput(ApiInput):
    kind: Literal["all", "group", "station"]
    group_uuid: str | None = Field(default=None, min_length=1, max_length=200)
    station_uuid: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def check_target(self):
        if self.kind == "group" and not self.group_uuid:
            raise ValueError("按组巡检需要指定分组。")
        if self.kind == "station" and not self.station_uuid:
            raise ValueError("单站巡检需要指定测点。")
        return self


class LabRunInput(ApiInput):
    messages: list[UserInput] = Field(min_length=1, max_length=1)
    scope: LabScopeInput


class CheckpointInput(ApiInput):
    message_ids: list[str] = Field(max_length=10000)


class TitleInput(ApiInput):
    input_text: str = Field(min_length=1, max_length=100000)


def sse_event(event: str, payload) -> dict:
    return {"event": event, "data": json.dumps(jsonable_encoder(payload), ensure_ascii=False)}


@dataclass
class ActiveRun:
    """一轮调查在后台任务中执行，和任何一个 HTTP 连接解耦；SSE 连接只是订阅者。

    浏览器刷新、关闭或网络中断不会取消调查，只有取消接口或服务关闭才会停止它。
    中途重新连接的订阅者先收到最近一次图状态，再收到其后的消息事件，然后继续实时接收。
    """
    id: str
    cancel_scope: anyio.CancelScope | None = None
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    stop_requested: bool = False
    task: asyncio.Task | None = None
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    latest_values: dict | None = None
    events_since_values: list[dict] = field(default_factory=list)
    project: Callable[[dict], dict] = project_state

    def publish(self, event: dict) -> None:
        self.events_since_values.append(event)
        for queue in self.subscribers:
            queue.put_nowait(event)

    def update_values(self, values: dict) -> None:
        self.latest_values = values
        self.events_since_values = []

    def subscribe(self, *, catch_up: bool) -> asyncio.Queue:
        queue = asyncio.Queue()
        queue.put_nowait(sse_event("metadata", {"run_id": self.id}))
        if catch_up:
            if self.latest_values is not None:
                queue.put_nowait(sse_event("values", self.project(self.latest_values)))
            for event in self.events_since_values:
                queue.put_nowait(event)
        if self.finished.is_set():
            queue.put_nowait(None)
        else:
            self.subscribers.add(queue)
        return queue

    def close(self) -> None:
        for queue in self.subscribers:
            queue.put_nowait(None)
        self.subscribers.clear()


async def relay_events(control: ActiveRun, queue: asyncio.Queue):
    """把一轮调查的事件转发给一个 SSE 连接；连接断开只退订，不影响调查。"""
    try:
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event
    finally:
        control.subscribers.discard(queue)


async def commit_completed_tool_results(agent, config):
    """停止、出错或进程退出时，并行工具中已完成的结果只在官方 pending writes 里；提交进 checkpoint。

    这样刷新后能看到这些真实结果，下一轮提交也不会把它们当作未完成的调用。不重新执行任何工具。
    """
    snapshot = await agent.aget_state(config)
    completed = {message.tool_call_id for message in snapshot.values.get("messages", []) if isinstance(message, ToolMessage)}
    results = []
    for task in snapshot.tasks:
        if task.name != "tools" or not isinstance(task.result, dict):
            continue
        for message in task.result.get("messages", []):
            if isinstance(message, ToolMessage) and message.tool_call_id not in completed:
                results.append(message)
    if not results:
        return snapshot
    config = await agent.aupdate_state(
        snapshot.config, {"messages": [*snapshot.values.get("messages", []), *results]}, as_node="tools",
    )
    return await agent.aget_state(config)


def project_lab_state(values: dict) -> dict:
    return {**project_state(values), "ui": list(values.get("ui", []))}


def lab_label(values: dict) -> str | None:
    for item in values.get("ui", []):
        if item.get("name") == SUMMARY_COMPONENT:
            return item.get("props", {}).get("label")
    return None


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
        kwargs = {}
        if body.focus_station:
            kwargs["lma_focus_station"] = body.focus_station
        if body.ask_targets:
            kwargs["metadata"] = {ASK_TARGETS_KEY: [ask_target_record(target) for target in body.ask_targets]}
        accepted.append(HumanMessage(id=user.id, content=user.content, additional_kwargs=kwargs))
    return accepted


def ask_target_record(target: AskTarget) -> dict:
    record = {
        "station_name": target.station_name,
        "start": target.start.astimezone(BUSINESS_TZ).isoformat(timespec="minutes"),
        "end": target.end.astimezone(BUSINESS_TZ).isoformat(timespec="minutes"),
    }
    if target.station_uuid is not None:
        record["station_uuid"] = str(target.station_uuid)
    if target.kind is not None:
        record["kind"] = target.kind
    if target.evidence_id is not None:
        record["evidence_id"] = target.evidence_id
    return record


_STATION_PAGE_CACHE = "station-page"


def create_app(settings: Settings | None = None, agent_factory=None, platform_client_factory=None) -> FastAPI:
    settings = settings or get_settings()
    platform_client_factory = platform_client_factory or build_platform_client
    active_runs: dict[str, ActiveRun] = {}
    active_lab_runs: dict[str, ActiveRun] = {}
    state_locks = WeakValueDictionary()
    active_inspections: set[asyncio.Task] = set()
    inspection_start_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with connection_pool(settings.database_uri, settings.database_pool_size) as pool:
            await pool.wait()
            storage = SessionStorage(pool)
            await storage.interrupt_previous_runs()
            checkpointer = AsyncPostgresSaver(pool)
            factory = agent_factory or (lambda saver, records: create_lma_agent(_get_llm(), checkpointer=saver, storage=records))
            app.state.agent = factory(checkpointer, storage)
            app.state.lab = build_lab_graph(platform_client_factory, checkpointer)
            app.state.storage = storage
            app.state.checkpointer = checkpointer
            app.state.suggestions = SuggestionService()
            app.state.tracing = AgentTracing(settings)
            try:
                yield
            finally:
                await app.state.suggestions.close()
                for inspection in active_inspections:
                    inspection.cancel()
                if active_inspections:
                    await asyncio.gather(*active_inspections, return_exceptions=True)
                runs = [*active_runs.values(), *active_lab_runs.values()]
                for run in runs:
                    run.stop_requested = True
                    if run.cancel_scope is not None:
                        run.cancel_scope.cancel()
                if runs:
                    await asyncio.gather(*(run.finished.wait() for run in runs))
                if app.state.tracing.client is not None:
                    await asyncio.to_thread(app.state.tracing.client.shutdown)

    if auth_enabled(settings) and len(settings.auth_secret) < 32:
        raise ValueError("已配置 AUTH_PASSWORD，必须同时配置至少 32 个字符的 AUTH_SECRET。")
    app = FastAPI(title="LMA 自托管 API", lifespan=lifespan, dependencies=[Depends(require_login(settings))])
    app.include_router(auth_router(settings))
    origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"],
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
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

    @app.get("/map-config")
    async def map_config():
        return {"amap_token": settings.amap_token or None}

    @app.get("/sessions")
    async def list_sessions(
        limit: int = Query(21, ge=1, le=100), offset: int = Query(0, ge=0),
        station_uuid: str | None = Query(None, min_length=1, max_length=200),
        search: str | None = Query(None, max_length=200),
    ):
        return await app.state.storage.list(limit, offset, station_uuid, search)

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
        if body.archived is not None:
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
            if session_id in active_runs:
                return await app.state.agent.aget_state(config)
            return await commit_completed_tool_results(app.state.agent, config)

    @app.get("/sessions/{session_id}/state")
    async def get_state(session_id: UUID):
        await require_session(session_id)
        snapshot = await reconciled_state(str(session_id), graph_config(str(session_id)))
        return {
            "values": project_state(snapshot.values),
            "latest_run": await app.state.storage.latest_run(str(session_id)),
        }

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
            task = asyncio.create_task(run_inspection(app.state.storage, inspection_id, platform_client_factory))
            active_inspections.add(task)
            task.add_done_callback(active_inspections.discard)
        return {"id": inspection_id}

    def station_directory_entry(station) -> dict:
        """测点列表与分组地图的一行：坐标采用统一的颠倒纠正；平台状态只在不是“正常”时给出。"""
        latitude, longitude = station_coordinates(station)
        status = STATION_STATUS_TEXT.get(station.station_status)
        return {
            "station_uuid": station.station_uuid,
            "station_name": station.station_name,
            "group_name": station.group_name,
            "station_type": STATION_TYPE_TEXT.get(station.station_type),
            "latitude": latitude,
            "longitude": longitude,
            "platform_status": None if status == "正常" else status,
        }

    @app.get("/stations")
    async def station_directory():
        try:
            async with platform_client_factory() as client:
                stations = await client.get_stations()
                return [station_directory_entry(station) for station in stations]
        except (BeidouApiError, httpx.HTTPError):
            logger.warning("station directory request failed", exc_info=True)
            raise HTTPException(502, "测点列表尚未载入。") from None

    def requested_window(days: int | None, begin: date | None, end: date | None) -> TimelineWindow:
        try:
            return timeline_window(days, begin, end)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @app.get("/stations/{station_uuid}/timeline")
    async def station_timeline(station_uuid: str, days: int | None = None, begin: date | None = None, end: date | None = None):
        window = requested_window(days, begin, end)
        try:
            async with monitoring_scope(_STATION_PAGE_CACHE, platform_client_factory) as data:
                station = await find_station(data, station_uuid)
                if station is None:
                    raise HTTPException(404, "测点不存在。")
                series = await load_station_series(data, station, window)
        except (BeidouApiError, httpx.HTTPError):
            logger.warning("station timeline request failed", exc_info=True)
            raise HTTPException(502, "监测平台数据暂不可用，请稍后重试。") from None
        return {
            "station_uuid": station.station_uuid,
            "station_name": station.station_name,
            "group_name": station.group_name,
            "series": series,
            "records": await app.state.storage.station_records(station.station_uuid),
        }

    @app.get("/stations/{station_uuid}/rainfall")
    async def station_rainfall(station_uuid: str, days: int | None = None, begin: date | None = None, end: date | None = None):
        """测点页时间轴下方的逐日降雨与强降雨前后速率；位移序列复用测点页缓存，不重复取数。"""
        window = requested_window(days, begin, end)
        try:
            async with monitoring_scope(_STATION_PAGE_CACHE, platform_client_factory) as data:
                station = await find_station(data, station_uuid)
                if station is None:
                    raise HTTPException(404, "测点不存在。")
                series = await load_station_series(data, station, window)
        except (BeidouApiError, httpx.HTTPError):
            logger.warning("station rainfall displacement request failed", exc_info=True)
            raise HTTPException(502, "监测平台数据暂不可用，请稍后重试。") from None
        latitude, longitude = station_coordinates(station)
        if latitude is None:
            raise HTTPException(404, "测点没有有效坐标，无法查询降雨。")
        rain_end = min(window.end.date(), business_now().date() - timedelta(days=1))
        rain_start = window.start.date()
        if rain_start > rain_end:
            return rainfall_payload([], [])
        try:
            daily = await daily_rainfall(latitude, longitude, rain_start, rain_end)
        except (httpx.HTTPError, ValueError):
            logger.warning("station rainfall request failed", exc_info=True)
            raise HTTPException(502, "降雨资料暂不可用，请稍后重试。") from None
        events = heavy_rain_events(daily)
        if series:
            events = with_displacement_rates(events, series["points"])
        return rainfall_payload(daily, events)

    @app.post("/suggestions")
    async def generate_suggestions():
        try:
            async with asyncio.timeout(15):
                return {"questions": await app.state.suggestions.get(app.state.storage)}
        except Exception:
            logger.warning("question suggestions unavailable", exc_info=True)
            return {"questions": []}

    @app.post("/title")
    async def create_title(body: TitleInput):
        try:
            return {"title": await asyncio.wait_for(generate_title(body.input_text), timeout=15)}
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
            try:
                await asyncio.wait_for(run.finished.wait(), timeout=30)
            except TimeoutError:
                return Response(status_code=202)
        return Response(status_code=204)

    @app.get("/sessions/{session_id}/runs/active")
    async def join_active_run(session_id: UUID):
        """刷新或重新打开页面后接回仍在进行的调查；没有进行中的调查时返回 204。"""
        await require_session(session_id)
        control = active_runs.get(str(session_id))
        if control is None or control.finished.is_set():
            return Response(status_code=204)
        queue = control.subscribe(catch_up=True)
        return EventSourceResponse(relay_events(control, queue), ping=15, send_timeout=30)

    async def execute_run(control: ActiveRun, key: str, messages: list, config: dict, branch: dict | None):
        """一轮调查的完整生命周期；只有图完整结束才记录成功。"""
        status = "cancelled"
        final_state = {}
        try:
            with app.state.tracing.run(
                config, session_id=key, run_id=control.id,
                input=[message.content for message in messages if isinstance(message, HumanMessage)],
            ) as trace:
                try:
                    async with monitoring_scope(key, platform_client_factory):
                        with anyio.CancelScope() as cancel_scope:
                            control.cancel_scope = cancel_scope
                            if control.stop_requested:
                                return
                            graph_input = {"messages": messages} if messages else None
                            async for mode, data in app.state.agent.astream(
                                graph_input, trace.config, stream_mode=["messages", "values"], durability="sync",
                            ):
                                if mode == "messages":
                                    message, metadata = data
                                    control.publish(sse_event("messages", [project_message(message), {
                                        "langgraph_node": metadata.get("langgraph_node"),
                                    }]))
                                    continue
                                if branch is not None:
                                    await app.state.storage.prune_branch(key, **branch)
                                    branch = None
                                final_state = data
                                control.update_values(data)
                            status = "success"
                            control.publish(sse_event("values", project_state(final_state)))
                except asyncio.CancelledError:
                    status = "cancelled"
                    raise
                except Exception:
                    status = "error"
                    logger.exception("agent run failed: %s", control.id)
                    control.publish(sse_event("error", {
                        "message": "本轮运行失败，已保存完成的步骤，请重新载入会话后重试。",
                    }))
                finally:
                    with anyio.CancelScope(shield=True):
                        await app.state.storage.finish_run(control.id, status)
                        trace.finish(status, final_state.get("messages", []))
        finally:
            active_runs.pop(key, None)
            control.finished.set()
            control.close()

    @app.post("/sessions/{session_id}/runs")
    async def stream_run(session_id: UUID, body: RunInput):
        session = await require_session(session_id)
        require_idle(session_id)
        key = str(session_id)
        config = graph_config(key, body.checkpoint_id)
        async with state_locks.setdefault(key, asyncio.Lock()):
            require_idle(session_id)
            snapshot = await commit_completed_tool_results(app.state.agent, config)
            control = ActiveRun(id=str(uuid4()))
            active_runs[key] = control
        config = snapshot.config if snapshot.created_at else config
        try:
            if body.checkpoint_id is not None and not snapshot.created_at:
                raise HTTPException(404, "checkpoint 不存在。")
            latest_run = await app.state.storage.latest_run(key)
            messages = prepare_messages(body, snapshot, latest_run)
            if body.focus_station_uuid is not None and session.get("station_uuid") != str(body.focus_station_uuid):
                raise HTTPException(422, "当前测点与会话归属不一致。")
            for message in messages:
                if isinstance(message, HumanMessage):
                    if body.focus_station and session.get("station_uuid"):
                        message.additional_kwargs["lma_focus_identity"] = {"station_uuid": session["station_uuid"], "station_name": body.focus_station}
            tool_results = [message for message in messages if isinstance(message, ToolMessage)]
            if tool_results:
                config = await app.state.agent.aupdate_state(
                    snapshot.config, {"messages": [*snapshot.values.get("messages", []), *tool_results]}, as_node="tools",
                )
                messages = [message for message in messages if isinstance(message, HumanMessage)]
            branch = None
            if body.checkpoint_id is not None:
                stored = snapshot.values.get("messages", [])
                branch = {
                    "tool_call_ids": [message.tool_call_id for message in stored if isinstance(message, ToolMessage)],
                    "message_ids": [str(message.id) for message in stored if isinstance(message, HumanMessage)],
                }
            await app.state.storage.start_run(key, control.id)
            queue = control.subscribe(catch_up=False)
            control.task = asyncio.create_task(execute_run(control, key, messages, config, branch))
        except BaseException:
            active_runs.pop(key, None)
            raise
        return EventSourceResponse(relay_events(control, queue), ping=15, send_timeout=30)


    @app.get("/lab/scopes")
    async def lab_scopes():
        try:
            async with platform_client_factory() as client:
                stations = stations_in_scope(await client.get_stations(), {"kind": "all"})
        except (BeidouApiError, httpx.HTTPError):
            logger.warning("lab scope request failed", exc_info=True)
            raise HTTPException(502, "测点列表尚未载入。") from None
        groups: dict[str, dict] = {}
        for station in stations:
            group = groups.setdefault(station.group_uuid, {
                "group_uuid": station.group_uuid, "group_name": station.group_name, "stations": [],
            })
            group["stations"].append({"station_uuid": station.station_uuid, "station_name": station.station_name})
        return {"groups": list(groups.values())}

    @app.get("/lab/inspections")
    async def list_lab_inspections(limit: int = Query(20, ge=1, le=100)):
        return await app.state.storage.list_lab_inspections(limit)

    @app.post("/lab/inspections", status_code=201)
    async def create_lab_inspection():
        return await app.state.storage.create_lab_inspection(str(uuid4()))

    async def require_lab_inspection(inspection_id: UUID) -> dict:
        inspection = await app.state.storage.get_lab_inspection(str(inspection_id))
        if inspection is None:
            raise HTTPException(404, "原型巡检不存在。")
        return inspection

    @app.get("/lab/inspections/{inspection_id}")
    async def get_lab_inspection(inspection_id: UUID):
        return await require_lab_inspection(inspection_id)

    @app.get("/lab/inspections/{inspection_id}/state")
    async def get_lab_state(inspection_id: UUID):
        inspection = await require_lab_inspection(inspection_id)
        snapshot = await app.state.lab.aget_state(graph_config(str(inspection_id)))
        return {"values": project_lab_state(snapshot.values), "status": inspection["status"]}

    @app.get("/lab/inspections/{inspection_id}/runs/active")
    async def join_lab_run(inspection_id: UUID):
        await require_lab_inspection(inspection_id)
        control = active_lab_runs.get(str(inspection_id))
        if control is None or control.finished.is_set():
            return Response(status_code=204)
        queue = control.subscribe(catch_up=True)
        return EventSourceResponse(relay_events(control, queue), ping=15, send_timeout=30)

    @app.post("/lab/inspections/{inspection_id}/cancel", status_code=204)
    async def cancel_lab_run(inspection_id: UUID):
        await require_lab_inspection(inspection_id)
        control = active_lab_runs.get(str(inspection_id))
        if control is not None:
            control.stop_requested = True
            if control.cancel_scope is not None:
                control.cancel_scope.cancel()
        return Response(status_code=204)

    async def execute_lab_run(control: ActiveRun, key: str, graph_input: dict) -> None:
        status = "cancelled"
        final_state: dict = {}
        try:
            with anyio.CancelScope() as cancel_scope:
                control.cancel_scope = cancel_scope
                async for mode, data in app.state.lab.astream(
                    graph_input, graph_config(key), stream_mode=["messages", "values", "custom"], durability="sync",
                ):
                    if mode == "messages":
                        message, metadata = data
                        control.publish(sse_event("messages", [project_message(message), {
                            "langgraph_node": metadata.get("langgraph_node"),
                        }]))
                    elif mode == "custom":
                        control.publish(sse_event("custom", data))
                    else:
                        final_state = data
                        control.update_values(data)
                if not cancel_scope.cancel_called:
                    status = "success"
                    control.publish(sse_event("values", project_lab_state(final_state)))
        except asyncio.CancelledError:
            raise
        except Exception:
            status = "error"
            logger.exception("inspection lab run failed: %s", control.id)
            control.publish(sse_event("error", {"message": "本次原型巡检失败，已推送的结果保留。"}))
        finally:
            with anyio.CancelScope(shield=True):
                await app.state.storage.finish_lab_inspection(key, status, lab_label(final_state))
            active_lab_runs.pop(key, None)
            control.finished.set()
            control.close()

    @app.post("/lab/inspections/{inspection_id}/runs")
    async def stream_lab_run(inspection_id: UUID, body: LabRunInput):
        await require_lab_inspection(inspection_id)
        key = str(inspection_id)
        if active_lab_runs:
            raise HTTPException(409, "已有原型巡检在进行，请等待完成。")
        control = ActiveRun(id=str(uuid4()), project=project_lab_state)
        active_lab_runs[key] = control
        try:
            user = body.messages[0]
            scope = body.scope.model_dump(exclude_none=True)
            labels = {"all": "全部测点", "group": "按组巡检", "station": "单站巡检"}
            await app.state.storage.start_lab_inspection(key, labels[body.scope.kind])
            graph_input = {"messages": [HumanMessage(id=user.id, content=user.content)], "scope": scope}
            queue = control.subscribe(catch_up=False)
            control.task = asyncio.create_task(execute_lab_run(control, key, graph_input))
        except BaseException:
            active_lab_runs.pop(key, None)
            raise
        return EventSourceResponse(relay_events(control, queue), ping=15, send_timeout=30)

    return app


app = create_app()
