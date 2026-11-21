"""会话目录、运行记录、巡检与测点结论索引；消息与工具结果只存于官方 LangGraph checkpointer。"""

import asyncio
import sys
from collections.abc import Sequence
from dataclasses import asdict

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS lma_sessions (
    id uuid PRIMARY KEY,
    name text NOT NULL DEFAULT '新会话',
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lma_sessions ADD COLUMN IF NOT EXISTS station_uuid text;
CREATE INDEX IF NOT EXISTS lma_sessions_station ON lma_sessions (station_uuid, updated_at DESC) WHERE station_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS lma_sessions_recent ON lma_sessions (updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS lma_runs (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('running', 'success', 'cancelled', 'error', 'interrupted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS lma_runs_session ON lma_runs (session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS lma_inspections (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('running', 'success', 'error', 'interrupted')),
    total_stations integer NOT NULL DEFAULT 0,
    completed_stations integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS lma_inspections_recent ON lma_inspections (started_at DESC);
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
-- 结构化初筛线索（类型、方向、窗口、幅度），供今日页与测点页按条呈现；reasons 保留给问题推荐。
ALTER TABLE lma_inspection_stations ADD COLUMN IF NOT EXISTS findings jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS lma_station_results (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL, station_uuid text NOT NULL, station_name text NOT NULL,
    status text NOT NULL, reason text NOT NULL, detail jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, tool_call_id, station_uuid)
);
CREATE INDEX IF NOT EXISTS lma_station_results_recent ON lma_station_results(station_uuid, created_at DESC);
CREATE TABLE IF NOT EXISTS lma_station_records (
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    anchor_id text NOT NULL, station_uuid text NOT NULL, station_name text NOT NULL,
    question text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, anchor_id, station_uuid)
);
CREATE INDEX IF NOT EXISTS lma_station_records_recent ON lma_station_records(station_uuid, created_at DESC);
-- 巡检原型：一次原型巡检是一条 LangGraph 线程，这里只记目录；结果和组件保存在 checkpoint。
CREATE TABLE IF NOT EXISTS lma_lab_inspections (
    id uuid PRIMARY KEY,
    label text NOT NULL DEFAULT '原型巡检',
    status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'success', 'error', 'cancelled', 'interrupted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS lma_lab_inspections_recent ON lma_lab_inspections (created_at DESC);
"""

_HISTORY_LIMIT = 5


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


class SessionStorage:
    def __init__(self, pool: AsyncConnectionPool):
        self.pool = pool

    async def save_conclusions(self, session_id: str, tool_call_id: str, stations: Sequence[dict]) -> None:
        """登记成功后立即写入测点结论索引；不等 Agent 收尾，中断后测点记录仍完整。"""
        async with self.pool.connection() as connection:
            async with connection.transaction():
                for station in stations:
                    await connection.execute(
                        """INSERT INTO lma_station_results(session_id,tool_call_id,station_uuid,station_name,status,reason,detail)
                           VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        (session_id, tool_call_id, station["station_uuid"], station["station_name"],
                         station["status"], station["reason"], Jsonb(station)),
                    )

    async def prune_branch(self, session_id: str, *, tool_call_ids: Sequence[str], message_ids: Sequence[str]) -> None:
        """从历史 checkpoint 分叉（编辑或重新生成）时，删除被替换分支留下的结论和测点记录。

        这两张表是 checkpoint 的派生索引；旧分支不再可见，它的结论不能继续出现在测点记录里。
        """
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "DELETE FROM lma_station_results WHERE session_id = %s AND NOT (tool_call_id = ANY(%s))",
                    (session_id, list(tool_call_ids)),
                )
                await connection.execute(
                    "DELETE FROM lma_station_records WHERE session_id = %s AND NOT (anchor_id = ANY(%s))",
                    (session_id, list(message_ids)),
                )

    async def record_station_mentions(self, session_id: str, anchor_id: str, question: str, stations: dict[str, str]) -> None:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                for station_uuid, station_name in stations.items():
                    await connection.execute(
                        """INSERT INTO lma_station_records(session_id,anchor_id,station_uuid,station_name,question)
                           VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        (session_id, anchor_id, station_uuid, station_name, question),
                    )

    async def station_records(self, station_uuid, limit=20):
        """测点页的历次调查：每个提问一行，附该会话对此测点最近登记的结论。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """SELECT r.session_id, r.anchor_id, r.station_uuid, r.station_name, s.name AS session_name,
                          c.status, COALESCE(c.reason, r.question) AS reason, r.created_at
                   FROM lma_station_records r JOIN lma_sessions s ON s.id = r.session_id
                   LEFT JOIN LATERAL (
                       SELECT status, reason FROM lma_station_results
                       WHERE session_id = r.session_id AND station_uuid = r.station_uuid
                       ORDER BY created_at DESC LIMIT 1
                   ) c ON true
                   WHERE r.station_uuid = %s ORDER BY r.created_at DESC LIMIT %s""",
                (station_uuid, limit),
            )
            return await cursor.fetchall()

    async def station_history(self, station_uuid: str) -> dict:
        """模型续查用：最近几次登记的结论及最近一次巡检初筛。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """SELECT c.status, c.reason, c.detail->>'begin_time' AS begin_time, c.detail->>'end_time' AS end_time,
                          c.created_at AS recorded_at, s.name AS session_name
                   FROM lma_station_results c JOIN lma_sessions s ON s.id = c.session_id
                   WHERE c.station_uuid = %s ORDER BY c.created_at DESC LIMIT %s""",
                (station_uuid, _HISTORY_LIMIT),
            )
            conclusions = await cursor.fetchall()
            cursor = await connection.execute(
                """SELECT s.screening, s.reasons, i.finished_at
                   FROM lma_inspection_stations s JOIN lma_inspections i ON i.id = s.inspection_id
                   WHERE s.station_uuid = %s AND i.status = 'success' ORDER BY i.started_at DESC LIMIT 1""",
                (station_uuid,),
            )
            inspection = await cursor.fetchone()
        return {"conclusions": conclusions, "latest_inspection": inspection}

    async def session_conclusions(self):
        """记录页：每个会话最近一次登记涉及的测点状态。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """WITH latest AS (SELECT DISTINCT ON (session_id) session_id, tool_call_id FROM lma_station_results
                                  ORDER BY session_id, created_at DESC)
                   SELECT r.session_id, r.station_uuid, r.station_name, r.status FROM lma_station_results r
                   JOIN latest USING (session_id, tool_call_id) ORDER BY r.session_id, r.station_uuid""",
            )
            return await cursor.fetchall()

    async def list(self, limit: int, offset: int, station_uuid: str | None = None, search: str | None = None) -> list[dict]:
        async with self.pool.connection() as connection:
            if search and search.strip():
                query = search.strip()
                cursor = await connection.execute(
                    """SELECT s.* FROM lma_sessions s
                       WHERE (%s::text IS NULL OR (s.station_uuid = %s AND s.archived = false))
                         AND (strpos(lower(s.name), lower(%s)) > 0
                           OR EXISTS (SELECT 1 FROM lma_station_records r WHERE r.session_id = s.id
                             AND strpos(lower(r.station_name), lower(%s)) > 0)
                           OR EXISTS (SELECT 1 FROM lma_station_results r WHERE r.session_id = s.id
                             AND strpos(lower(r.station_name), lower(%s)) > 0))
                       ORDER BY s.updated_at DESC, s.id DESC LIMIT %s OFFSET %s""",
                    (station_uuid, station_uuid, query, query, query, limit, offset),
                )
                return await cursor.fetchall()
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

    async def create_lab_inspection(self, inspection_id: str) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "INSERT INTO lma_lab_inspections (id) VALUES (%s) RETURNING *", (inspection_id,),
            )
            return await cursor.fetchone()

    async def get_lab_inspection(self, inspection_id: str) -> dict | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute("SELECT * FROM lma_lab_inspections WHERE id = %s", (inspection_id,))
            return await cursor.fetchone()

    async def list_lab_inspections(self, limit: int) -> Sequence[dict]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT * FROM lma_lab_inspections WHERE status <> 'idle' ORDER BY created_at DESC LIMIT %s", (limit,),
            )
            return await cursor.fetchall()

    async def start_lab_inspection(self, inspection_id: str, label: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_lab_inspections SET status = 'running', label = %s, finished_at = NULL WHERE id = %s",
                (label, inspection_id),
            )

    async def finish_lab_inspection(self, inspection_id: str, status: str, label: str | None) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                """UPDATE lma_lab_inspections SET status = %s, label = COALESCE(%s, label), finished_at = now()
                   WHERE id = %s""",
                (status, label, inspection_id),
            )

    async def interrupt_previous_runs(self) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_runs SET status = 'interrupted', ended_at = now() WHERE status = 'running'",
            )
            await connection.execute(
                "UPDATE lma_inspections SET status = 'interrupted', finished_at = now() WHERE status = 'running'",
            )
            await connection.execute(
                "UPDATE lma_lab_inspections SET status = 'interrupted', finished_at = now() WHERE status = 'running'",
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
                           (inspection_id, station_uuid, station_name, group_name, screening, reasons, findings, metrics, trend)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (inspection_id, station.station_uuid, station.station_name, station.group_name,
                         result.screening, Jsonb(result.reasons), Jsonb([asdict(finding) for finding in result.findings]),
                         Jsonb(result.metrics), Jsonb(result.trend)),
                    )

    async def finish_inspection(self, inspection_id: str, status: str) -> None:
        async with self.pool.connection() as connection:
            await connection.execute(
                "UPDATE lma_inspections SET status = %s, finished_at = now() WHERE id = %s",
                (status, inspection_id),
            )

    async def suggestion_sources(self) -> dict:
        """推荐专用的有界投影；不读趋势数组、原始观测或会话 checkpoint。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """WITH latest AS (
                       SELECT id, finished_at FROM lma_inspections
                       WHERE status = 'success' ORDER BY started_at DESC, id DESC LIMIT 1
                   ), inspected AS (
                       SELECT s.station_uuid, s.station_name, s.group_name, s.screening,
                              jsonb_path_query_array(s.reasons, '$[0 to 5]') AS reasons,
                              s.metrics - 'long_quality' - 'recent_quality' || jsonb_build_object(
                                  'long_quality', (s.metrics->'long_quality') - 'gaps',
                                  'recent_quality', (s.metrics->'recent_quality') - 'gaps'
                              ) AS metrics
                       FROM lma_inspection_stations s JOIN latest ON latest.id = s.inspection_id
                       ORDER BY CASE s.screening WHEN '建议调查' THEN 0 WHEN '数据不足' THEN 1
                                    WHEN '暂无法分析' THEN 2 ELSE 3 END, s.station_uuid
                       LIMIT 4
                   ), investigated AS (
                       SELECT DISTINCT ON (c.station_uuid) c.station_uuid, c.station_name, c.created_at
                       FROM lma_station_results c JOIN lma_sessions s ON s.id = c.session_id
                       WHERE s.archived = false
                         AND NOT EXISTS (SELECT 1 FROM inspected i WHERE i.station_uuid = c.station_uuid)
                       ORDER BY c.station_uuid, c.created_at DESC, c.session_id, c.tool_call_id
                   ), candidates AS (
                       SELECT * FROM inspected
                       UNION ALL
                       SELECT station_uuid, station_name, '' AS group_name, NULL AS screening,
                              '[]'::jsonb AS reasons, '{}'::jsonb AS metrics
                       FROM (SELECT * FROM investigated ORDER BY created_at DESC, station_uuid LIMIT 2) r
                   ), name_counts AS (
                       SELECT station_name, count(DISTINCT station_uuid) AS total FROM (
                           SELECT station_uuid, station_name FROM lma_inspection_stations
                           WHERE inspection_id = (SELECT id FROM latest)
                           UNION ALL
                           SELECT r.station_uuid, r.station_name FROM lma_station_results r
                           JOIN lma_sessions s ON s.id = r.session_id WHERE s.archived = false
                       ) names WHERE station_name IN (SELECT station_name FROM candidates)
                       GROUP BY station_name
                   )
                   SELECT c.*,
                          CASE WHEN c.screening IS NOT NULL THEN (SELECT finished_at FROM latest) END AS inspection_recorded_at,
                          CASE WHEN c.screening IS NOT NULL THEN (SELECT id FROM latest) END AS inspection_id,
                          COALESCE(history.items, '[]'::jsonb) AS conclusions,
                          names.total AS same_name_count
                   FROM candidates c
                   JOIN name_counts names USING (station_name)
                   LEFT JOIN LATERAL (
                       SELECT jsonb_agg(item ORDER BY recorded_at DESC, session_id, tool_call_id) AS items
                       FROM (
                           SELECT r.created_at AS recorded_at, r.session_id, r.tool_call_id,
                                  jsonb_build_object(
                                      'status', r.status, 'reason', left(r.reason, 200),
                                      'begin_time', r.detail->>'begin_time',
                                      'end_time', r.detail->>'end_time',
                                      'recorded_at', r.created_at, 'session_id', r.session_id,
                                      'tool_call_id', r.tool_call_id
                                  ) AS item
                           FROM lma_station_results r JOIN lma_sessions s ON s.id = r.session_id
                           WHERE r.station_uuid = c.station_uuid AND s.archived = false
                           ORDER BY r.created_at DESC, r.session_id, r.tool_call_id LIMIT 2
                       ) recent
                   ) history ON true
                   ORDER BY c.station_uuid""",
            )
            return {"stations": await cursor.fetchall()}

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
                   FROM lma_station_results WHERE station_uuid = ANY(%s)
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
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(migrate_database(get_settings().database_uri), loop_factory=loop_factory)
