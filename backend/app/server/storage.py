"""会话目录与运行记录；消息只存于官方 LangGraph checkpointer。"""

import asyncio
import sys
from collections.abc import Sequence

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
CREATE TABLE IF NOT EXISTS lma_runs (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES lma_sessions(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('running', 'success', 'cancelled', 'error', 'interrupted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
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


class SessionStorage:
    def __init__(self, pool: AsyncConnectionPool):
        self.pool = pool

    async def list(self, limit: int, offset: int) -> list[dict]:
        async with self.pool.connection() as connection:
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

    async def create(self, session_id: str, name: str) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "INSERT INTO lma_sessions (id, name) VALUES (%s, %s) RETURNING *",
                (session_id, name),
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
            await connection.execute(
                "UPDATE lma_runs SET status = 'interrupted', ended_at = now() WHERE status = 'running'",
            )
            await connection.execute(
                "UPDATE lma_inspections SET status = 'interrupted', finished_at = now() WHERE status = 'running'",
            )

    async def record_conclusions(self, session_id: str, tool_call_id: str, stations: Sequence[dict]) -> None:
        """重新生成会产生新的调用 ID，因此同一测点可保留多次结论。"""
        async with self.pool.connection() as connection:
            for station in stations:
                await connection.execute(
                    """INSERT INTO lma_station_conclusions (session_id, tool_call_id, station_name, status, reason)
                       VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                    (session_id, tool_call_id, station["station_name"], station["status"], station["reason"]),
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
        """最近一次成功巡检；进行中的巡检单独返回进度，旧结果在完成前保持可用。"""
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT total_stations, completed_stations FROM lma_inspections WHERE status = 'running' "
                "ORDER BY started_at DESC LIMIT 1",
            )
            running = await cursor.fetchone()
            cursor = await connection.execute(
                "SELECT * FROM lma_inspections WHERE status = 'success' ORDER BY started_at DESC LIMIT 2",
            )
            finished = await cursor.fetchall()
            if not finished:
                return {"running": running, "inspection": None, "stations": []}

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
                """SELECT DISTINCT ON (station_name) station_name, status, reason, session_id, created_at
                   FROM lma_station_conclusions
                   WHERE station_name = ANY(%s)
                   ORDER BY station_name, created_at DESC""",
                ([row["station_name"] for row in stations],),
            )
            conclusions = {row["station_name"]: row for row in await cursor.fetchall()}

        return {
            "running": running,
            "inspection": finished[0],
            "stations": [
                {
                    **row,
                    "previous_screening": previous.get(row["station_uuid"]),
                    "last_conclusion": conclusions.get(row["station_name"]),
                }
                for row in stations
            ],
        }


if __name__ == "__main__":
    # Psycopg 的异步连接要求 Windows 使用 SelectorEventLoop。
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(migrate_database(get_settings().database_uri), loop_factory=loop_factory)
