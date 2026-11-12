"""真实模型、合成平台与隔离数据库评测；结果按业务标准人工审阅。"""
import asyncio
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.artifacts import validate_artifact_envelope
from app.agent.compute import compute
from app.agent.conclusions import record_conclusions
from app.agent.graph import create_lma_agent, _get_llm
from app.agent.session_tools import update_plan
from app.agent.tools import find_stations, get_displacement
from app.config import get_settings
from app.monitoring_data import monitoring_scope
from app.server.storage import SessionStorage, connection_pool, migrate_database
from evaluations.fixtures import MonitoringFixture, NEW_STATION, STATION_A, STATION_B

# 评测只用合成监测平台；天气、场地和视觉依赖外部服务，不绑定这些工具。
_EVALUATION_TOOLS = [find_stations, get_displacement, compute, update_plan, record_conclusions]


async def seed_previous_conclusion(storage):
    """在另一个会话中登记评测点A的以往结论，供“以往结论”场景读取。"""
    session_id = str(uuid4())
    await storage.create(session_id, "以往评测调查")
    artifact = validate_artifact_envelope({
        "version": 1, "kind": "conclusions", "status": "success",
        "data": {"stations": [{
            "station_uuid": STATION_A, "station_name": "评测点A", "status": "未见明显变化",
            "reason": "2026-11-01 至 11-08 北向未见净变化", "begin_time": "2026-11-01 00:00:00",
            "end_time": "2026-11-08 00:00:00", "evidence": [],
        }]},
    })
    await storage.save_evidence(session_id, "evaluation-previous", artifact, execution_id="evaluation")
    return session_id


async def clear_unrelated_history(storage):
    """隔离库中其他测试会留下同 UUID 的巡检与结论；评测前清除，避免模型读到与合成数据无关的历史。"""
    stations = [STATION_A, STATION_B, NEW_STATION]
    async with storage.pool.connection() as connection:
        await connection.execute("DELETE FROM lma_inspection_stations WHERE station_uuid = ANY(%s)", (stations,))
        await connection.execute("DELETE FROM lma_station_results WHERE station_uuid = ANY(%s)", (stations,))


def evaluation_version():
    root = Path(__file__).resolve().parents[2]
    settings = get_settings()
    files = ['backend/app/agent/prompts/system.md', 'backend/evaluations/fixtures.py',
             'backend/evaluations/investigation_scenarios.json', 'backend/requirements.txt']
    return {
        'code_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'working_diff_sha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=root)).hexdigest(),
        'model': settings.llm_model, 'provider': settings.llm_provider, 'thinking': settings.llm_thinking,
        'model_run_limit': settings.agent_model_run_limit, 'tool_run_limit': settings.agent_tool_run_limit,
        'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
        'data_version': 'synthetic-review-2026-11-11-v3',
    }


def check_deterministic_results(messages):
    """验证程序可确定的数值事实；自然语言解释仍需逐项业务审阅。"""
    failures = []
    checked_metrics = 0
    final_answers = [message for message in messages
                     if message.type == 'ai' and message.text.strip()]
    if not final_answers:
        failures.append('本轮没有交付可读回答')
    for message in messages:
        artifact = getattr(message, 'artifact', None)
        if not isinstance(artifact, dict) or artifact.get('kind') != 'gnss_series' or artifact.get('status') == 'error':
            continue
        data = artifact['data']
        for axis in ('n', 'e', 'u'):
            feature = data.get('features', {}).get(axis, {})
            valid = sorted((point['time'], float(point[axis])) for point in data['points']
                           if isinstance(point.get(axis), (int, float)) and math.isfinite(point[axis]))
            if feature.get('count') != len(valid):
                failures.append(f'{message.tool_call_id}/{axis} 单站有效数量与实际点集不一致')
            if len(valid) >= 2:
                expected_change = (valid[-1][1] - valid[0][1]) * 1000
                actual_change = feature.get('net_change_mm')
                if actual_change is None or not math.isclose(actual_change, expected_change, abs_tol=1e-6):
                    failures.append(f'{message.tool_call_id}/{axis} 净变化与原始首末值不一致')
            checked_metrics += 1
        comparisons = data.get('comparisons', {})
        snapshots = comparisons.get('snapshots', {})
        for axis, station_features in comparisons.get('common_period', {}).items():
            times_by_station = [
                {point['time'] for point in points
                 if isinstance(point.get(axis), (int, float)) and math.isfinite(point[axis])}
                for points in snapshots.values()
            ]
            common_times = set.intersection(*times_by_station) if times_by_station else set()
            for station, feature in station_features.items():
                if feature.get('count') != len(common_times):
                    failures.append(f'{message.tool_call_id}/{station}/{axis} 共同数量与逐站有效时刻交集不一致')
                checked_metrics += 1
    conclusions = [message.artifact['data']['stations'] for message in messages
                   if isinstance(message, ToolMessage) and isinstance(message.artifact, dict)
                   and message.artifact.get('kind') == 'conclusions' and message.status != 'error']
    return {'checked_sample_metrics': checked_metrics, 'conclusions': conclusions, 'failures': failures,
            'scope': '仅验证数值特征与原始点集一致；结论措辞与推断需人工审阅'}


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
    version = evaluation_version()
    async with connection_pool(database_uri) as pool:
        await pool.wait()
        storage = SessionStorage(pool)
        saver = AsyncPostgresSaver(pool)
        await clear_unrelated_history(storage)
        for scenario in scenarios:
            print(f"开始评测：{scenario['id']}", flush=True)
            fixture = MonitoringFixture(scenario['id'])
            session_id = str(uuid4())
            await storage.create(session_id, "合成模型评测")
            previous_session = await seed_previous_conclusion(storage) if scenario['id'] == 'historical_refresh' else None
            started = time.monotonic()
            final = {}
            error = None
            try:
                async with monitoring_scope(session_id, client_factory=lambda: fixture):
                    agent = create_lma_agent(model, agent_tools=_EVALUATION_TOOLS, checkpointer=saver, storage=storage)
                    observed_calls = set()
                    async with asyncio.timeout(360):
                        async for values in agent.astream(
                            {"messages": [HumanMessage(content=scenario["question"])]},
                            {"configurable": {"thread_id": session_id}}, stream_mode="values", durability='sync',
                        ):
                            final = values
                            for message in values.get("messages", []):
                                if isinstance(message, ToolMessage) and message.tool_call_id not in observed_calls:
                                    observed_calls.add(message.tool_call_id)
                                    print(f"  {message.name}: {message.status}", flush=True)
            except Exception as exc:
                error = type(exc).__name__
                print(f'  评测中断：{error}，保留部分结果', flush=True)
            finally:
                try:
                    results.append({
                        **scenario, "data_source": "合成监测平台",
                        'version': version, 'elapsed_seconds': round(time.monotonic() - started, 2), 'execution_error': error,
                        "messages": [message.model_dump(mode="json") for message in final.get("messages", [])],
                        "requests": fixture.requests,
                        "review": "待按criteria逐项业务审阅；执行结束不代表评测通过",
                        'deterministic': check_deterministic_results(final.get('messages', [])),
                    })
                    if destination:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
                finally:
                    for identifier in filter(None, (session_id, previous_session)):
                        await storage.delete(identifier)
                        await saver.adelete_thread(identifier)
    return results


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', action='append', help='仅运行指定场景，可重复；默认运行全部')
    parser.add_argument('--output', type=Path, help='保存本次结果的独立路径，避免覆盖已有评测证据')
    args = parser.parse_args()
    if os.environ.get("LMA_RUN_MODEL_EVAL") != "1":
        raise SystemExit("未执行真实模型评测；显式设置LMA_RUN_MODEL_EVAL=1后运行，会消耗模型额度")
    database_uri = os.environ.get("LMA_TEST_DATABASE_URI", "")
    if not database_uri.endswith("/lma_test"):
        raise SystemExit("评测只允许独立LMA_TEST_DATABASE_URI，数据库名必须为lma_test")
    destination = args.output or Path("evaluations/results") / f"model-evaluation-{time.time_ns()}.json"
    await run_scenarios(_get_llm(), database_uri, scenario_ids=args.scenario, destination=destination)
    print(f"结果已保存到{destination.resolve()}，尚待业务评审")


if __name__ == "__main__":
    asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop if sys.platform == "win32" else None)
