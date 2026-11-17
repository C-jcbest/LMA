"""由隔离运行恢复回归启动：提供真实 HTTP 服务，或在并行工具完成一部分后强制结束进程。"""
import asyncio
import os
import sys

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.graph import create_lma_agent
from app.server.storage import SessionStorage, connection_pool
from runtime_fixtures import ScriptedModel
from test_run_recovery import observation

PARALLEL_CALLS = [
    {'id': 'completed-observation', 'name': 'observation', 'args': {}},
    {'id': 'slow-observation', 'name': 'slow_observation', 'args': {}},
]


def isolated_uri() -> str:
    uri = os.environ['LMA_TEST_DATABASE_URI']
    if not uri.endswith('/lma_test'):
        raise ValueError('只允许隔离lma_test数据库')
    return uri


def slow_tool(seconds: float):
    @tool
    async def slow_observation() -> str:
        """维持一个较慢的并行取数，用于核验断流、停止和进程退出时已完成的结果。"""
        await asyncio.sleep(seconds)
        return '较慢观测完成'

    return slow_observation


def serve(port: int, slow_seconds: float):
    import uvicorn
    from app.config import Settings
    from app.server.api import create_app

    settings = Settings(_env_file=None, database_uri=isolated_uri(), context_model_context=1048576)

    def factory(saver, storage):
        model = ScriptedModel(script=[
            AIMessage(content='', tool_calls=PARALLEL_CALLS),
            AIMessage(content='两项观测均已取得，北向无明显变化。'),
        ])
        return create_lma_agent(model, agent_tools=[observation, slow_tool(slow_seconds)],
                                checkpointer=saver, storage=storage,
                                summary_model=ScriptedModel(script=[]))

    uvicorn.run(
        create_app(settings, factory), host='127.0.0.1', port=port, log_level='error',
        loop='app.server.loop:create_loop' if sys.platform == 'win32' else 'asyncio',
    )


async def crash_after_first_tool(session: str):
    """快工具完成并写入官方 pending writes 后，慢工具执行期间进程直接退出。"""
    @tool
    async def slow_observation() -> str:
        """在已完成的并行结果提交后结束进程。"""
        await asyncio.sleep(1)
        os._exit(73)

    async with connection_pool(isolated_uri()) as pool:
        await pool.wait()
        model = ScriptedModel(script=[AIMessage(id='executing', content='', tool_calls=PARALLEL_CALLS)])
        agent = create_lma_agent(model, agent_tools=[observation, slow_observation],
                                 checkpointer=AsyncPostgresSaver(pool), storage=SessionStorage(pool),
                                 summary_model=ScriptedModel(script=[]))
        await agent.ainvoke({'messages': [HumanMessage(content='读取隔离观测')]},
                            {'configurable': {'thread_id': session}}, durability='sync')


if __name__ == '__main__':
    if sys.argv[1] == '--serve':
        serve(int(sys.argv[2]), float(sys.argv[3]))
    else:
        asyncio.run(crash_after_first_tool(sys.argv[1]),
                    loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)
