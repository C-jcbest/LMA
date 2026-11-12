"""由隔离故障回归启动，在工具证据提交后强制结束进程。"""
import asyncio
import os
import sys

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.graph import create_lma_agent
from app.server.storage import SessionStorage, connection_pool
from runtime_fixtures import ScriptedModel
from test_evidence_recovery import observation


@tool
async def unfinished_observation() -> str:
    """维持一个尚未完成的并行取数，用于断流时核验已完成结果。"""
    await asyncio.sleep(60)
    return '延迟观测完成'


def serve():
    import uvicorn
    from app.config import Settings
    from app.server.api import create_app

    uri = os.environ['LMA_TEST_DATABASE_URI']
    if not uri.endswith('/lma_test'):
        raise ValueError('只允许隔离lma_test数据库')
    settings = Settings(_env_file=None, database_uri=uri, context_model_context=100000)

    def factory(saver, storage):
        model = ScriptedModel(script=[AIMessage(content='', tool_calls=[
            {'id': 'completed-observation', 'name': 'observation', 'args': {}},
            {'id': 'unfinished-observation', 'name': 'unfinished_observation', 'args': {}},
        ])])
        return create_lma_agent(model, agent_tools=[observation, unfinished_observation],
                                checkpointer=saver, storage=storage,
                                summary_model=ScriptedModel(script=[]))

    uvicorn.run(
        create_app(settings, factory), host='127.0.0.1', port=int(sys.argv[2]), log_level='error',
        loop='app.server.loop:create_loop' if sys.platform == 'win32' else 'asyncio',
    )


async def main():
    uri = os.environ['LMA_TEST_DATABASE_URI']
    if not uri.endswith('/lma_test'):
        raise ValueError('只允许隔离lma_test数据库')
    async with connection_pool(uri) as pool:
        await pool.wait()
        storage = SessionStorage(pool)
        save = storage.save_evidence

        async def crash_after_commit(*args, **kwargs):
            await save(*args, **kwargs)
            os._exit(73)

        storage.save_evidence = crash_after_commit
        model = ScriptedModel(script=[AIMessage(id='executing', content='', tool_calls=[
            {'id':'observation', 'name':'observation', 'args':{}},
        ])])
        agent = create_lma_agent(model, agent_tools=[observation], checkpointer=AsyncPostgresSaver(pool),
                                 storage=storage, summary_model=ScriptedModel(script=[]))
        await agent.ainvoke({'messages':[HumanMessage(content='读取隔离观测')]},
                            {'configurable':{'thread_id':sys.argv[1]}}, durability='sync')


if __name__ == '__main__':
    if sys.argv[1] == '--serve':
        serve()
    else:
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop if sys.platform == 'win32' else None)
