"""会话目录与运行记录；消息只存于官方 LangGraph checkpointer。"""

import asyncio
import sys
from uuid import NAMESPACE_URL, uuid5
from collections.abc import Sequence

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings
from app.server.investigation_models import InvestigationProgress
from app.server.investigations import station_identities
from langchain_core.messages import HumanMessage, ToolMessage

SCHEMA = """
CREATE TABLE IF NOT EXISTS lma_sessions (
    id uuid PRIMARY KEY,
    name text NOT NULL DEFAULT '新会话',
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lma_investigations (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    progress jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('running','paused','completed','interrupted','cancelled','error')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revision integer NOT NULL DEFAULT 1
);
ALTER TABLE lma_investigations ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS lma_evidence (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL,
    snapshot jsonb NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    execution_id text NOT NULL DEFAULT 'manual',
    message jsonb,
    UNIQUE (session_id, execution_id, tool_call_id)
);
ALTER TABLE lma_evidence ADD COLUMN IF NOT EXISTS execution_id text NOT NULL DEFAULT 'manual';
ALTER TABLE lma_evidence ADD COLUMN IF NOT EXISTS message jsonb;
ALTER TABLE lma_evidence DROP CONSTRAINT IF EXISTS lma_evidence_session_id_tool_call_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS lma_evidence_execution ON lma_evidence(session_id, execution_id, tool_call_id);
CREATE TABLE IF NOT EXISTS lma_runs (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('running', 'success', 'cancelled', 'error', 'interrupted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
ALTER TABLE lma_sessions ADD COLUMN IF NOT EXISTS station_uuid text;
CREATE INDEX IF NOT EXISTS lma_sessions_station ON lma_sessions (station_uuid, updated_at DESC) WHERE station_uuid IS NOT NULL;
CREATE TABLE IF NOT EXISTS lma_inspections (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('running', 'success', 'error', 'interrupted')),
    total_stations integer NOT NULL DEFAULT 0,
    completed_stations integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS lma_inspection_stations (
    inspection_id uuid NOT NULL REFERENCES lma_inspections(id) ON DELETE CASCADE,
    station_uuid text NOT NULL,
    station_name text NOT NULL,
    group_name text NOT NULL,
    screening text NOT NULL,
    reasons jsonb NOT NULL,
    metrics jsonb NOT NULL,
    trend jsonb NOT NULL,
    PRIMARY KEY (inspection_id, station_uuid)
);
CREATE TABLE IF NOT EXISTS lma_station_conclusions (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL,
    station_name text NOT NULL,
    status text NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, tool_call_id, station_name)
);
CREATE INDEX IF NOT EXISTS lma_inspections_recent ON lma_inspections (started_at DESC);
CREATE INDEX IF NOT EXISTS lma_station_conclusions_recent ON lma_station_conclusions (station_name, created_at DESC);
CREATE INDEX IF NOT EXISTS lma_sessions_recent ON lma_sessions (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS lma_runs_session ON lma_runs (session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS lma_station_investigations (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    anchor_id text NOT NULL,
    station_name text NOT NULL,
    report_tool_call_id text,
    question text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, anchor_id, station_name)
);
CREATE INDEX IF NOT EXISTS lma_station_investigations_recent ON lma_station_investigations (station_name, created_at DESC);
INSERT INTO lma_station_investigations (session_id, anchor_id, station_name, report_tool_call_id, question, created_at)
SELECT session_id, tool_call_id, station_name, tool_call_id, reason, created_at FROM lma_station_conclusions
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS lma_station_results (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL, station_uuid text NOT NULL, station_name text NOT NULL,
    status text NOT NULL, reason text NOT NULL, detail jsonb NOT NULL,
    validated boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, tool_call_id, station_uuid)
);
CREATE INDEX IF NOT EXISTS lma_station_results_recent ON lma_station_results(station_uuid, created_at DESC);
CREATE TABLE IF NOT EXISTS lma_station_records (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    anchor_id text NOT NULL, station_uuid text NOT NULL, station_name text NOT NULL,
    report_tool_call_id text, question text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, anchor_id, station_uuid)
);
CREATE INDEX IF NOT EXISTS lma_station_records_recent ON lma_station_records(station_uuid, created_at DESC);
ALTER TABLE lma_investigations ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
"""


def connection_pool(uri: str, max_size: int = 6) -> AsyncConnectionPool:
    if not uri:
        raise ValueError("自托管服务必须配置 DATABASE_URI。")
    return AsyncConnectionPool(
        uri, min_size=1, max_size=max_size, open=False,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    )


async def migrate_database(uri: str) -> None:
    """由部署的一次性迁移任务调用，不在每个 Web worker 中迁移。"""
    async with connection_pool(uri) as pool:
        await pool.wait()
        await AsyncPostgresSaver(pool).setup()
        async with pool.connection() as connection:
            await connection.execute(SCHEMA, prepare=False)
        await migrate_domain_records(pool)


async def migrate_domain_records(pool):
    """只按原回答所在轮的唯一身份迁移，保留旧表及无法定位的历史，不借当前站表猜造UUID。"""
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from app.server.investigations import station_identities
    saver = AsyncPostgresSaver(pool)
    async with pool.connection() as connection:
        cursor = await connection.execute("SELECT id, progress, status FROM lma_investigations WHERE contract_version=1")
        for row in await cursor.fetchall():
            previous = row["progress"]
            targets = [{**target, "outcome": "pending", "result": "历史关联尚未经当前结果契约复核"} for target in previous["targets"]]
            progress = {**previous, "targets": targets, "covered": [], "unresolved": [target["question"] for target in targets],
                        "changes": [{"source": "contract_migration", "reason": "保留原进度，旧覆盖需核验证据适用性", "previous_progress": previous, "previous_status": row["status"]}]}
            await connection.execute("UPDATE lma_investigations SET progress=%s, status=CASE WHEN status='completed' THEN 'paused' ELSE status END, contract_version=2 WHERE id=%s", (Jsonb(progress), row["id"]))
        cursor = await connection.execute("""SELECT DISTINCT session_id FROM lma_station_investigations
                                            UNION SELECT DISTINCT session_id FROM lma_evidence WHERE execution_id='manual'""")
        sessions = await cursor.fetchall()
    for session in sessions:
        session_id = str(session["session_id"])
        checkpoint = await saver.aget_tuple({"configurable": {"thread_id": session_id}})
        if checkpoint is None:
            continue
        messages = checkpoint.checkpoint.get("channel_values", {}).get("messages", [])
        calls = {}
        for message in messages:
            if isinstance(message, AIMessage):
                for call in message.tool_calls:
                    calls.setdefault(call["id"], []).append(str(message.id))
        async with pool.connection() as connection:
            cursor = await connection.execute("SELECT * FROM lma_evidence WHERE session_id=%s AND execution_id='manual'", (session_id,))
            for item in await cursor.fetchall():
                origins = calls.get(item["tool_call_id"], [])
                if len(origins) == 1:
                    await connection.execute("UPDATE lma_evidence SET execution_id=%s WHERE id=%s", (origins[0], item["id"]))
            cursor = await connection.execute("SELECT * FROM lma_station_investigations WHERE session_id=%s", (session_id,))
            records = await cursor.fetchall()
            for record in records:
                anchor = next((index for index, message in enumerate(messages) if message.id == record["anchor_id"] or
                               isinstance(message, ToolMessage) and message.tool_call_id == record["anchor_id"]), None)
                if anchor is None:
                    continue
                start = next((index for index in range(anchor, -1, -1) if isinstance(messages[index], HumanMessage)), None)
                if start is None:
                    continue
                candidates = [identifier for identifier, name in station_identities(messages[start:anchor + 1]).items() if name == record["station_name"]]
                if len(candidates) != 1:
                    continue
                await connection.execute("""INSERT INTO lma_station_records(session_id,anchor_id,station_uuid,station_name,report_tool_call_id,question,created_at)
                                            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                         (session_id, record["anchor_id"], candidates[0], record["station_name"], record["report_tool_call_id"], record["question"], record["created_at"]))
                if record["report_tool_call_id"]:
                    await connection.execute("""INSERT INTO lma_station_results(session_id,tool_call_id,station_uuid,station_name,status,reason,detail,validated,created_at)
                                                SELECT session_id,tool_call_id,%s,station_name,status,reason,'{}'::jsonb,false,created_at FROM lma_station_conclusions
                                                WHERE session_id=%s AND tool_call_id=%s AND station_name=%s ON CONFLICT DO NOTHING""",
                                             (candidates[0], session_id, record["report_tool_call_id"], record["station_name"]))


class SessionStorage:
    def __init__(self, pool: AsyncConnectionPool):
        self.pool = pool

    async def _validate_target_evidence(self, connection, session_id, target):
        if target.outcome in {"pending", "withdrawn"}:
            return
        for identifier in target.evidence_ids:
            cursor = await connection.execute("SELECT snapshot FROM lma_evidence WHERE id=%s AND session_id=%s", (str(identifier), session_id))
            item = await cursor.fetchone()
            if item is None:
                raise ValueError("调查引用的证据不属于当前会话或不存在")
            snapshot = item["snapshot"]
            data = snapshot.get("data", {})
            identity = data.get("station_uuid") or data.get("center_station", {}).get("station_uuid") or data.get("location", {}).get("station_uuid")
            if identity != str(target.station_uuid):
                raise ValueError("调查对象与证据测点不一致")
            if target.outcome == "answered":
                kinds = {"numerical"} if target.required_kind == "numerical" else {
                    "data_quality": {"numerical", "gnss_series", "vision"}, "weather": {"weather"}, "site": {"site_environment"},
                }[target.required_kind]
                if snapshot.get("status") != "success" or snapshot.get("kind") not in kinds:
                    raise ValueError("证据失败或类型不适用于该目标，不能标为问题已回答")
                if snapshot.get("kind") == "numerical" and not any(feature.get("count", 0) >= 2 for feature in data.get("features", {}).values()):
                    raise ValueError("没有足够有效数值观测，只能记录证据不足")
            if target.required_kind != "site":
                from app.agent.report import _business_time
                if snapshot.get("kind") == "weather":
                    query = data.get("query", {})
                    begin = query.get("history_start_date")
                    end = query.get("history_end_date")
                    if not begin or not end or target.begin_time.date() < _business_time(begin).date() or target.end_time.date() > _business_time(end).date():
                        raise ValueError("历史气象窗口不适用；当前和预报不能冒充历史观测")
                else:
                    begin, end = data.get("begin_time"), data.get("end_time")
                    if not begin or not end or _business_time(begin) > target.begin_time or _business_time(end) < target.end_time:
                        raise ValueError("证据查询窗口未覆盖调查目标，不能用错窗证据完成目标")

    async def save_progress(self, session_id, investigation_id, progress, *, expected_revision=None):
        validated = InvestigationProgress.model_validate(progress)
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("SET LOCAL statement_timeout = '5s'")
                cursor = await connection.execute("SELECT * FROM lma_investigations WHERE id=%s FOR UPDATE", (investigation_id,))
                previous = await cursor.fetchone()
                if previous is not None:
                    if str(previous["session_id"]) != session_id:
                        raise ValueError("调查不属于当前会话")
                    if expected_revision != previous["revision"]:
                        raise ValueError(f"调查版本冲突，请读取最新状态后更新；当前revision={previous['revision']}")
                    if {target["target_id"] for target in previous["progress"]["targets"]} - {target.target_id for target in validated.targets}:
                        raise ValueError("不能删除原目标；范围缩小时保留目标并记录撤回原因")
                for target in validated.targets:
                    await self._validate_target_evidence(connection, session_id, target)
                values = validated.model_dump(mode="json")
                cursor = await connection.execute(
                    """INSERT INTO lma_investigations (id,session_id,progress,status,contract_version) VALUES (%s,%s,%s,%s,2)
                       ON CONFLICT (id) DO UPDATE SET progress=EXCLUDED.progress, status=EXCLUDED.status,
                           revision=lma_investigations.revision+1, updated_at=now() RETURNING *""",
                    (investigation_id, session_id, Jsonb({key: value for key, value in values.items() if key != "status"}), validated.status),
                )
                return await cursor.fetchone()

    async def update_target(self, session_id, investigation_id, target_id, *, outcome, result, evidence_ids, expected_revision):
        record = await self.investigation(session_id, investigation_id)
        if record is None:
            raise ValueError("当前会话不存在该调查")
        progress = record["progress"]
        target = next((target for target in progress["targets"] if target["target_id"] == target_id), None)
        if target is None:
            raise ValueError("调查中不存在该目标")
        target.update(outcome=outcome, result=result, evidence_ids=evidence_ids)
        progress["covered"] = [target["target_id"] for target in progress["targets"] if target.get("outcome") == "answered"]
        progress["unresolved"] = [target["question"] for target in progress["targets"] if target.get("outcome", "pending") == "pending"]
        progress["status"] = "running"
        return await self.save_progress(session_id, investigation_id, progress, expected_revision=expected_revision)

    async def revise_targets(self, session_id, investigation_id, targets, *, reason, source, message_id, expected_revision):
        record = await self.investigation(session_id, investigation_id)
        if record is None:
            raise ValueError("当前会话不存在该调查")
        progress = record["progress"]
        previous = {target["target_id"]: target for target in progress["targets"]}
        for target in targets:
            if target["target_id"] in previous:
                raise ValueError("既有目标不可替换或删除；保留原目标并明确撤回后再添加新目标")
            previous[target["target_id"]] = target
        progress["targets"] = list(previous.values())
        progress.setdefault("changes", []).append({"reason": reason, "source": source, "message_id": message_id, "added": [target["target_id"] for target in targets]})
        progress["status"] = "running"
        progress["unresolved"] = [target["question"] for target in progress["targets"] if target.get("outcome", "pending") == "pending"]
        return await self.save_progress(session_id, investigation_id, progress, expected_revision=expected_revision)

    async def finish_investigation(self, session_id, investigation_id, conclusion, expected_revision):
        record = await self.investigation(session_id, investigation_id)
        if record is None:
            raise ValueError("当前会话不存在该调查")
        progress = {**record["progress"], "status": "completed", "stage_conclusion": conclusion, "unresolved": []}
        return await self.save_progress(session_id, investigation_id, progress, expected_revision=expected_revision)

    async def investigation(self, session_id: str, investigation_id: str) -> dict | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_investigations WHERE id=%s AND session_id=%s",
                (investigation_id, session_id),
            )
            return await cursor.fetchone()

    async def investigations(self, session_id: str) -> list[dict]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_investigations WHERE session_id=%s ORDER BY updated_at DESC", (session_id,),
            )
            return await cursor.fetchall()

    async def save_evidence(self, session_id: str, tool_call_id: str, snapshot: dict, *, execution_id="manual", message=None) -> dict:
        identifier = str(uuid5(NAMESPACE_URL, f"lma:{session_id}:{execution_id}:{tool_call_id}"))
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("SET LOCAL statement_timeout = '5s'")
                await connection.execute(
                    """INSERT INTO lma_evidence (id,session_id,execution_id,tool_call_id,snapshot,message)
                       VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id,execution_id,tool_call_id) DO UPDATE SET message=COALESCE(lma_evidence.message, EXCLUDED.message)""",
                    (identifier, session_id, execution_id, tool_call_id, Jsonb(snapshot), Jsonb(message)),
                )
                cursor = await connection.execute(
                    "SELECT * FROM lma_evidence WHERE session_id=%s AND execution_id=%s AND tool_call_id=%s",
                    (session_id, execution_id, tool_call_id),
                )
                return await cursor.fetchone()

    async def existing_evidence_ids(self, session_id, identifiers):
        if not identifiers:
            return set()
        async with self.pool.connection() as connection:
            cursor = await connection.execute("SELECT id FROM lma_evidence WHERE session_id=%s AND id=ANY(%s::uuid[])", (session_id, identifiers))
            return {str(row["id"]) for row in await cursor.fetchall()}

    async def executed_evidence(self, session_id, execution_id, tool_call_id):
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_evidence WHERE session_id=%s AND execution_id=%s AND tool_call_id=%s",
                (session_id, execution_id, tool_call_id),
            )
            return await cursor.fetchone()

    async def evidence(self, session_id: str) -> list[dict]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_evidence WHERE session_id=%s ORDER BY acquired_at", (session_id,),
            )
            return await cursor.fetchall()

    async def evidence_item(self, session_id: str, evidence_id: str) -> dict | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_evidence WHERE session_id=%s AND id=%s",
                (session_id, evidence_id),
            )
            return await cursor.fetchone()

    async def evidence_catalog(self, session_id, *, limit=30, offset=0, investigation_id=None):
        """目录不读取原始序列、图像或完整snapshot；调查筛选只覆盖目标对象与窗口。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """SELECT e.id, e.tool_call_id, e.execution_id, e.acquired_at,
                          e.snapshot->>'kind' AS kind, e.snapshot->>'status' AS status,
                          COALESCE(e.snapshot->'data'->>'station_uuid', e.snapshot->'data'->'center_station'->>'station_uuid',
                                   e.snapshot->'data'->'location'->>'station_uuid') AS station_uuid,
                          COALESCE(e.snapshot->'data'->>'station_name', e.snapshot->'data'->'center_station'->>'station_name',
                                   e.snapshot->'data'->'location'->>'station_name') AS station_name,
                          e.snapshot->'data'->>'begin_time' AS begin_time, e.snapshot->'data'->>'end_time' AS end_time,
                          e.snapshot->'limitations' AS limitations
                   FROM lma_evidence e WHERE e.session_id=%s AND
                       (%s::uuid IS NULL OR EXISTS (
                           SELECT 1 FROM lma_investigations i, jsonb_array_elements(i.progress->'targets') t
                           WHERE i.id=%s AND i.session_id=e.session_id AND
                             (t->>'station_uuid'=COALESCE(e.snapshot->'data'->>'station_uuid', e.snapshot->'data'->'center_station'->>'station_uuid', e.snapshot->'data'->'location'->>'station_uuid'))))
                   ORDER BY e.acquired_at DESC, e.id LIMIT %s OFFSET %s""",
                (session_id, investigation_id, investigation_id, limit + 1, offset),
            )
            records = await cursor.fetchall()
            return {"items": records[:limit], "next_offset": offset + limit if len(records) > limit else None}

    async def pause_investigations(self, session_id: str, reason: str, stage_conclusion: str = "") -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                """UPDATE lma_investigations SET status=%s, updated_at=now(),
                   progress=jsonb_set(jsonb_set(progress, '{end_reason}', to_jsonb(%s::text)), '{stage_conclusion}',
                       CASE WHEN %s::text = '' THEN COALESCE(progress->'stage_conclusion', '""'::jsonb) ELSE to_jsonb(%s::text) END)
                   WHERE session_id=%s AND status='running'""",
                ("paused" if reason in {"success", "budget"} else reason, reason, stage_conclusion, stage_conclusion, session_id),
            )

    async def list(self, limit: int, offset: int, station_uuid: str | None = None) -> list[dict]:
        async with self.pool.connection() as connection:
            if station_uuid is not None:
                cursor = await connection.execute(
                    """SELECT * FROM lma_sessions WHERE station_uuid = %s AND archived = false
                       ORDER BY updated_at DESC, id DESC LIMIT %s OFFSET %s""",
                    (station_uuid, limit, offset),
                )
                return await cursor.fetchall()
            cursor = await connection.execute(
                "SELECT * FROM lma_sessions ORDER BY updated_at DESC, id DESC LIMIT %s OFFSET %s",
                (limit, offset),
            )
            return await cursor.fetchall()

    async def get(self, session_id: str) -> dict | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_sessions WHERE id = %s", (session_id,),
            )
            return await cursor.fetchone()

    async def create(self, session_id: str, name: str, station_uuid: str | None = None) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "INSERT INTO lma_sessions (id, name, station_uuid) VALUES (%s, %s, %s) RETURNING *",
                (session_id, name, station_uuid),
            )
            return await cursor.fetchone()

    async def update(self, session_id: str, name: str | None, archived: bool | None) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """UPDATE lma_sessions SET name = COALESCE(%s, name),
                   archived = COALESCE(%s, archived), updated_at = now()
                   WHERE id = %s RETURNING *""",
                (name, archived, session_id),
            )
            return await cursor.fetchone()

    async def delete(self, session_id: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute("DELETE FROM lma_sessions WHERE id = %s", (session_id,))

    async def start_run(self, session_id: str, run_id: str) -> None:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "INSERT INTO lma_runs (id, session_id, status) VALUES (%s, %s, 'running')",
                    (run_id, session_id),
                )
                await connection.execute(
                    "UPDATE lma_sessions SET updated_at = now() WHERE id = %s", (session_id,),
                )

    async def finish_run(self, run_id: str, status: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_runs SET status = %s, ended_at = now() WHERE id = %s",
                (status, run_id),
            )

    async def latest_run(self, session_id: str) -> dict | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_runs WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
                (session_id,),
            )
            return await cursor.fetchone()

    async def interrupt_previous_runs(self) -> None:
        async with self.pool.connection() as connection:
            await connection.execute("UPDATE lma_investigations SET status='interrupted', updated_at=now() WHERE status='running'")
            await connection.execute(
                "UPDATE lma_runs SET status = 'interrupted', ended_at = now() WHERE status = 'running'",
            )
            await connection.execute(
                "UPDATE lma_inspections SET status = 'interrupted', finished_at = now() WHERE status = 'running'",
            )

    async def record_conclusions(self, session_id, tool_call_id, stations):
        async with self.pool.connection() as connection:
            async with connection.transaction():
                for station in stations:
                    await connection.execute(
                        """INSERT INTO lma_station_results(session_id,tool_call_id,station_uuid,station_name,status,reason,detail)
                           VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        (session_id, tool_call_id, station["station_uuid"], station["station_name"], station["status"], station["reason"], Jsonb(station)),
                    )

    async def session_conclusions(self):
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """WITH latest AS (SELECT DISTINCT ON (session_id) session_id,tool_call_id FROM lma_station_results
                                  WHERE validated ORDER BY session_id, created_at DESC)
                   SELECT r.session_id,r.station_uuid,r.station_name,r.status FROM lma_station_results r
                   JOIN latest USING(session_id,tool_call_id) WHERE r.validated ORDER BY r.session_id,r.station_uuid""",
            )
            return await cursor.fetchall()

    async def station_records(self, station_uuid, limit=20):
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """SELECT r.session_id,r.anchor_id,r.station_uuid,r.station_name,s.name AS session_name,
                          CASE WHEN c.validated THEN c.status END AS status,c.status AS historical_status,c.validated,
                          COALESCE(c.reason,r.question) AS reason,r.created_at
                   FROM lma_station_records r JOIN lma_sessions s ON s.id=r.session_id
                   LEFT JOIN lma_station_results c ON c.session_id=r.session_id AND c.tool_call_id=r.report_tool_call_id AND c.station_uuid=r.station_uuid
                   WHERE r.station_uuid=%s ORDER BY r.created_at DESC LIMIT %s""", (station_uuid, limit),
            )
            return await cursor.fetchall()

    async def record_investigation(self, session_id, record):
        async with self.pool.connection() as connection:
            async with connection.transaction():
                for station in record["stations"]:
                    await connection.execute(
                        """INSERT INTO lma_station_records(session_id,anchor_id,station_uuid,station_name,report_tool_call_id,question)
                           VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        (session_id,record["anchor_id"],station["station_uuid"],station["station_name"],record["report_tool_call_id"],record["question"]),
                    )

    async def start_inspection(self, inspection_id: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "INSERT INTO lma_inspections (id, status) VALUES (%s, 'running')", (inspection_id,),
            )

    async def set_inspection_total(self, inspection_id: str, total: int) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_inspections SET total_stations = %s WHERE id = %s", (total, inspection_id),
            )

    async def increment_inspection_progress(self, inspection_id: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_inspections SET completed_stations = completed_stations + 1 WHERE id = %s",
                (inspection_id,),
            )

    async def save_inspection_stations(self, inspection_id: str, screened: Sequence[tuple]) -> None:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                for station, result in screened:
                    await connection.execute(
                        """INSERT INTO lma_inspection_stations
                           (inspection_id, station_uuid, station_name, group_name, screening, reasons, metrics, trend)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                        (inspection_id, station.station_uuid, station.station_name, station.group_name,
                         result.screening, Jsonb(result.reasons), Jsonb(result.metrics), Jsonb(result.trend)),
                    )

    async def finish_inspection(self, inspection_id: str, status: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_inspections SET status = %s, finished_at = now() WHERE id = %s",
                (status, inspection_id),
            )

    async def latest_inspection(self) -> dict:
        """最近一次尝试及最近成功结果；失败和中断不覆盖已完成的结果。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT id, status, finished_at, total_stations, completed_stations FROM lma_inspections "
                "ORDER BY started_at DESC LIMIT 1",
            )
            latest_attempt = await cursor.fetchone()
            running = None
            if latest_attempt and latest_attempt["status"] == "running":
                running = {
                    "total_stations": latest_attempt["total_stations"],
                    "completed_stations": latest_attempt["completed_stations"],
                }
            cursor = await connection.execute(
                "SELECT * FROM lma_inspections WHERE status = 'success' ORDER BY started_at DESC LIMIT 2",
            )
            finished = await cursor.fetchall()
            if not finished:
                return {
                    "running": running,
                    "latest_attempt": latest_attempt,
                    "inspection": None,
                    "stations": [],
                }

            cursor = await connection.execute(
                "SELECT * FROM lma_inspection_stations WHERE inspection_id = %s", (finished[0]["id"],),
            )
            stations = await cursor.fetchall()
            previous = {}
            if len(finished) > 1:
                cursor = await connection.execute(
                    "SELECT station_uuid, screening FROM lma_inspection_stations WHERE inspection_id = %s",
                    (finished[1]["id"],),
                )
                previous = {row["station_uuid"]: row["screening"] for row in await cursor.fetchall()}
            cursor = await connection.execute(
                """SELECT DISTINCT ON (station_uuid) station_uuid, station_name, status, reason, session_id, created_at
                   FROM lma_station_results WHERE validated AND station_uuid = ANY(%s)
                   ORDER BY station_uuid, created_at DESC""",
                ([row["station_uuid"] for row in stations],),
            )
            conclusions = {row["station_uuid"]: row for row in await cursor.fetchall()}

        return {
            "running": running,
            "latest_attempt": latest_attempt,
            "inspection": finished[0],
            "stations": [
                {
                    **row,
                    "previous_screening": previous.get(row["station_uuid"]),
                    "last_conclusion": conclusions.get(row["station_uuid"]),
                }
                for row in stations
            ],
        }


if __name__ == "__main__":
    # Psycopg 的异步连接要求 Windows 使用 SelectorEventLoop。
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(migrate_database(get_settings().database_uri), loop_factory=loop_factory)
