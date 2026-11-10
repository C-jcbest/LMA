"""真实模型、合成平台与隔离数据库评测；结果按业务标准人工审阅。"""
import asyncio
import argparse
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.graph import create_lma_agent, _get_llm
from app.agent.numerical_tool import analyze_gnss_numerically
from app.agent.report import submit_investigation_report
from app.agent.tools import get_daily_gnss_data, list_stations, list_station_groups
from app.server.storage import SessionStorage, connection_pool, migrate_database
from evaluations.fixtures import MonitoringFixture, STATION_A, STATION_B


async def seed_history(storage, session_id):
    """用生产数值工具建立已完成A、待调查B的原调查。"""
    original = await analyze_gnss_numerically.ainvoke({
        "type": "tool_call", "id": "evaluation-original", "name": "analyze_gnss_numerically",
        "args": {"station_name_or_uuid": STATION_A,
                 "begin_time": "2026-11-01 00:00:00", "end_time": "2026-11-08 00:00:00"},
    })
    await storage.save_evidence(session_id, original.tool_call_id, original.artifact)
    evidence = (await storage.evidence(session_id))[0]
    investigation_id = str(uuid4())
    targets = [
        {"target_id": key, "station_uuid": station, "question": f"复核评测点{key}的变化",
         "begin_time": "2026-11-01T00:00:00", "end_time": "2026-11-08T00:00:00",
         "evidence_ids": [str(evidence["id"])] if key == "A" else []}
        for key, station in (("A", STATION_A), ("B", STATION_B))
    ]
    await storage.save_progress(session_id, investigation_id, {
        "goal": "复核同组两个测点", "targets": targets, "covered": ["A"], "unresolved": ["B尚未复核"],
        "stage_conclusion": "A在原窗口内未见净变化，B尚未覆盖", "status": "paused", "end_reason": "budget",
    })
    return investigation_id


async def run_scenarios(model, database_uri, *, scenario_ids=None, destination=None):
    if not database_uri.endswith("/lma_test"):
        raise ValueError("评测只允许独立lma_test数据库")
    scenarios = json.loads(Path(__file__).with_name("investigation_scenarios.json").read_text(encoding="utf-8-sig"))
    if scenario_ids:
        unknown = set(scenario_ids) - {scenario['id'] for scenario in scenarios}
        if unknown:
            raise ValueError(f"未知场景：{', '.join(sorted(unknown))}")
        scenarios = [scenario for scenario in scenarios if scenario['id'] in scenario_ids]
    await migrate_database(database_uri)
    results = []
    async with connection_pool(database_uri) as pool:
        await pool.wait()
        storage = SessionStorage(pool)
        saver = AsyncPostgresSaver(pool)
        for scenario in scenarios:
            print(f"开始评测：{scenario['id']}", flush=True)
            fixture = MonitoringFixture()
            session_id = str(uuid4())
            await storage.create(session_id, "合成模型评测")
            try:
                with patch("app.agent.tools._build_client", return_value=fixture), patch("app.agent.numerical_tool._build_client", return_value=fixture):
                    question = scenario["question"]
                    if scenario["id"] in {"historical_refresh", "resume_budget"}:
                        investigation_id = await seed_history(storage, session_id)
                        question += f" 原调查编号：{investigation_id}。"
                    fixture.requests.clear()
                    agent = create_lma_agent(
                        model, agent_tools=[list_station_groups, list_stations, get_daily_gnss_data,
                                            analyze_gnss_numerically, submit_investigation_report],
                        checkpointer=saver, investigation_storage=storage,
                    )
                    final = {}
                    observed_calls = set()
                    # 与生产API一样，在values边界保存证据，下一次模型调用即可引用持久化UUID。
                    async for values in agent.astream(
                        {"messages": [HumanMessage(content=question)]},
                        {"configurable": {"thread_id": session_id}}, stream_mode="values",
                    ):
                        final = values
                        for message in values.get("messages", []):
                            if isinstance(message, ToolMessage) and message.tool_call_id not in observed_calls:
                                observed_calls.add(message.tool_call_id)
                                print(f"  {message.name}: {message.status}", flush=True)
                            if isinstance(message, ToolMessage) and message.artifact and message.name != "reuse_investigation_evidence":
                                await storage.save_evidence(session_id, message.tool_call_id, message.artifact)
                    await storage.pause_investigations(session_id, 'success')
                    results.append({
                        **scenario, "data_source": "合成监测平台",
                        "messages": [message.model_dump(mode="json") for message in final.get("messages", [])],
                        "requests": fixture.requests, "investigations": await storage.investigations(session_id),
                        "evidence": await storage.evidence(session_id),
                        "review": "待按criteria逐项业务审阅；执行结束不代表评测通过",
                    })
                    if destination:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
            finally:
                await storage.delete(session_id)
                await saver.adelete_thread(session_id)
    return results


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', action='append', help='仅运行指定场景，可重复；默认运行全部')
    args = parser.parse_args()
    if os.environ.get("LMA_RUN_MODEL_EVAL") != "1":
        raise SystemExit("未执行真实模型评测；显式设置LMA_RUN_MODEL_EVAL=1后运行，会消耗模型额度")
    database_uri = os.environ.get("LMA_TEST_DATABASE_URI", "")
    if not database_uri.endswith("/lma_test"):
        raise SystemExit("评测只允许独立LMA_TEST_DATABASE_URI，数据库名必须为lma_test")
    destination = Path("evaluations/results/model-evaluation-results.json")
    await run_scenarios(_get_llm(), database_uri, scenario_ids=args.scenario, destination=destination)
    print(f"结果已保存到{destination.resolve()}，尚待业务评审")


if __name__ == "__main__":
    asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop if sys.platform == "win32" else None)
