"""会话目录与运行记录；消息只存于官方 LangGraph checkpointer。"""

import asyncio
import sys

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
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


if __name__ == "__main__":
    # Psycopg 的异步连接要求 Windows 使用 SelectorEventLoop。
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(migrate_database(get_settings().database_uri), loop_factory=loop_factory)
