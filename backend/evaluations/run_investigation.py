"""真实模型、合成平台与隔离数据库评测；结果按业务标准人工审阅。"""
import asyncio
import argparse
import json
import hashlib
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.graph import create_lma_agent, _get_llm
from app.config import get_settings
from app.beidou.client import station_catalog_scope
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
         "evidence_ids": [str(evidence["id"])] if key == "A" else [],
         "outcome": "answered" if key == "A" else "pending",
         "result": "原窗口内已复核净变化" if key == "A" else ""}
        for key, station in (("A", STATION_A), ("B", STATION_B))
    ]
    await storage.save_progress(session_id, investigation_id, {
        "goal": "复核同组两个测点", "targets": targets, "covered": ["A"], "unresolved": ["B尚未复核"],
        "stage_conclusion": "A在原窗口内未见净变化，B尚未覆盖", "status": "paused", "end_reason": "budget",
    })
    return investigation_id


def evaluation_version():
    root = Path(__file__).resolve().parents[2]
    settings = get_settings()
    files = ['backend/app/agent/prompts/system.md', 'backend/evaluations/fixtures.py',
             'backend/evaluations/investigation_scenarios.json', 'backend/requirements.txt']
    return {
        'code_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'working_diff_sha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=root)).hexdigest(),
        'model': settings.llm_model, 'provider': settings.llm_provider, 'thinking': settings.llm_thinking,
        'model_run_limit':settings.agent_model_run_limit, 'tool_run_limit':settings.agent_tool_run_limit,
        'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
        'data_version': 'synthetic-review-2026-11-11-v2',
    }


def check_deterministic_results(messages):
    """验证程序可确定的事实与引用；自然语言解释仍需逐项业务审阅。"""
    from app.agent.message_context import evidence_id
    from app.agent.report import EvidenceSupport, _validate_support, project_support
    facts = {evidence_id(message.tool_call_id): message.artifact for message in messages
             if isinstance(message, ToolMessage) and isinstance(message.artifact, dict)}
    checked = 0
    failures = []
    final_answers = [message for message in messages
                     if message.type == 'ai' and not message.tool_calls and message.text.strip()]
    delivered_reports = [message for message in messages if isinstance(message, ToolMessage)
                         and message.status != 'error' and isinstance(message.artifact, dict)
                         and message.artifact.get('kind') == 'investigation_report']
    if not final_answers and not delivered_reports:
        failures.append('本轮没有交付可读回答或成功报告')
    checked_metrics = 0
    for message in messages:
        artifact = getattr(message, 'artifact', None)
        if not isinstance(artifact, dict) or artifact.get('kind') != 'numerical':
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
    for message in messages:
        if not isinstance(message, ToolMessage) or message.status == 'error' or not message.artifact:
            continue
        if message.artifact.get('kind') != 'investigation_report':
            continue
        data = message.artifact['data']
        for item in [*data['stations'], *data['findings']]:
            for support in item['supports']:
                try:
                    validated = EvidenceSupport.model_validate({key:value for key,value in support.items() if key != 'fact'})
                    artifact = facts[validated.evidence_id]
                    _validate_support(validated, artifact)
                    if support.get('fact') != project_support(validated, artifact).get('fact'):
                        raise ValueError('服务端投影事实与引用结果不一致')
                    checked += 1
                except (ValueError, KeyError) as exc:
                    failures.append(str(exc))
    return {'checked_supports': checked, 'checked_sample_metrics': checked_metrics, 'failures': failures,
            'scope': '仅验证结构化结果的引用及事实投影；未提交报告不自动记为业务通过'}


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
        for scenario in scenarios:
            print(f"开始评测：{scenario['id']}", flush=True)
            fixture = MonitoringFixture(scenario['id'])
            session_id = str(uuid4())
            await storage.create(session_id, "合成模型评测")
            started = time.monotonic()
            final = {}
            error = None
            try:
                with station_catalog_scope(), patch("app.agent.tools._build_client", return_value=fixture), patch("app.agent.numerical_tool._build_client", return_value=fixture):
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
                    observed_calls = set()
                    async with asyncio.timeout(360):
                        async for values in agent.astream(
                            {"messages": [HumanMessage(content=question)]},
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
                    budget_exhausted = any(
                        message.additional_kwargs.get('lma_budget_exhausted')
                        for message in final.get('messages', [])
                        if message.type == 'ai'
                    )
                    end_reason = 'budget' if budget_exhausted else 'success'
                    if error:
                        end_reason = 'error'
                    await storage.pause_investigations(session_id, end_reason)
                    results.append({
                        **scenario, "data_source": "合成监测平台",
                        'version':version, 'elapsed_seconds': round(time.monotonic() - started, 2), 'execution_error':error,
                        "messages": [message.model_dump(mode="json") for message in final.get("messages", [])],
                        "requests": fixture.requests, "investigations": await storage.investigations(session_id),
                        "evidence": await storage.evidence(session_id),
                        "review": "待按criteria逐项业务审阅；执行结束不代表评测通过",
                        'deterministic': check_deterministic_results(final.get('messages', [])),
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
