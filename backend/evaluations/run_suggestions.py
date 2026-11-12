"""真实配置模型的推荐验收，仅发送合成摘要，不访问监测平台或业务会话。

在 backend 中执行：python -m evaluations.run_suggestions --env-file <本机已有.env>
输出 questions 供人工审阅；时间仅为当前网络和提供方下的观测值。
"""

import argparse
import asyncio
import copy
import json
import os
import statistics
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app.agent.suggestions import SuggestionService, suggestion_context
from app.config import Settings
from app.inspection.screening import ScreeningResult
from app.server.storage import migrate_database


def synthetic_cases():
    row = {
        "station_uuid": "11111111-1111-1111-1111-111111111111", "station_name": "演示点A",
        "group_name": "演示坡体", "same_name_count": 1, "inspection_id": "synthetic",
        "inspection_recorded_at": "2026-11-12 16:00:00", "screening": "建议调查",
        "reasons": ["北向 89 天持续同向变化，约 +18.0 mm"],
        "metrics": {"net_change_mm": {"n": 18, "e": 0, "u": 0},
                    "slope_mm_per_day": {"n": 0.2, "e": 0, "u": 0}},
        "conclusions": [],
    }
    for key, start, count in (("long", "2026-08-14 16:00:00", 90), ("recent", "2026-11-05 16:00:00", 169)):
        row["metrics"][f"{key}_quality"] = {
            "requested_begin": start, "requested_end": "2026-11-12 16:00:00",
            "expected": count, "missing": 0,
            "axes": {axis: {"valid": count, "first_valid_time": start,
                            "latest_valid_time": "2026-11-12 16:00:00"} for axis in "neu"},
        }
    cases = {"巡检持续变化": {"stations": [copy.deepcopy(row)]}}
    row["conclusions"] = [{
        "status": "持续关注", "reason": "此前已确认缓慢同向变化，无加速；成因尚未明确",
        "begin_time": "2026-08-14 16:00:00", "end_time": "2026-11-12 16:00:00",
        "recorded_at": "2026-11-12 17:00:00",
    }]
    cases["同窗已有解释"] = {"stations": [copy.deepcopy(row)]}
    row["reasons"].append("近期小时序列：北向近 1.7 天变化快于此前，仍需分窗复核")
    row["conclusions"][0]["end_time"] = "2026-11-05 16:00:00"
    cases["旧解释后新变化"] = {"stations": [copy.deepcopy(row)]}
    row["conclusions"][0].update(status="未见明显变化", reason="同一窗口北向未见明显变化", end_time="2026-11-12 16:00:00")
    cases["巡检与结论冲突"] = {"stations": [copy.deepcopy(row)]}
    row["screening"] = "数据不足"
    row["reasons"] = ["近 90 天仅有 3 天有效数据，无法判断长期趋势", "最近 48 小时没有数据"]
    row["conclusions"] = []
    row["metrics"]["net_change_mm"] = {axis: None for axis in "neu"}
    row["metrics"]["slope_mm_per_day"] = {axis: None for axis in "neu"}
    for key in ("long", "recent"):
        quality = row["metrics"][f"{key}_quality"]
        quality["missing"] = quality["expected"] - 3
        for axis in quality["axes"].values():
            axis.update(valid=3, latest_valid_time="2026-11-07 16:00:00")
    cases["数据不足"] = {"stations": [copy.deepcopy(row)]}
    stable = copy.deepcopy(cases["巡检持续变化"]["stations"][0])
    stable.update(screening="未见明显变化", reasons=[])
    stable["metrics"].update(net_change_mm={axis: 0.0 for axis in "neu"}, slope_mm_per_day={axis: 0.0 for axis in "neu"})
    cases["全部平稳"] = {"stations": [stable]}
    historical = copy.deepcopy(row)
    historical.update(screening=None, reasons=[], metrics={}, conclusions=[{
        "status": "需人工复核", "reason": "该历史窗口北向出现台阶，成因待核实",
        "begin_time": "2026-01-01 00:00:00", "end_time": "2026-01-07 00:00:00",
        "recorded_at": "2026-11-12 17:00:00",
    }])
    cases["只有历史调查无巡检"] = {"stations": [historical]}
    other = copy.deepcopy(stable)
    other.update(station_uuid="22222222-2222-2222-2222-222222222222", group_name="另一坡体", same_name_count=2)
    same = copy.deepcopy(cases["巡检持续变化"]["stations"][0])
    same["same_name_count"] = 2
    cases["同名不同UUID"] = {"stations": [same, other]}
    cases["没有数据"] = {"stations": []}
    return cases


class SyntheticSources:
    def __init__(self, sources):
        self.sources = sources

    async def suggestion_sources(self):
        return self.sources


async def evaluate(env_file, selected):
    settings = Settings(_env_file=env_file)
    records = []
    for name, sources in synthetic_cases().items():
        if selected and name not in selected:
            continue
        storage = SyntheticSources(sources)
        service = SuggestionService()
        start = time.perf_counter()
        with patch("app.agent.suggestions.get_settings", return_value=settings):
            questions = await service.get(storage)
            cold_ms = (time.perf_counter() - start) * 1000
            start = time.perf_counter()
            warm = await service.get(storage)
            warm_ms = (time.perf_counter() - start) * 1000
        await service.close()
        records.append({"scenario": name, "source": "synthetic", "model": settings.llm_model,
                        "context": suggestion_context(sources), "questions": questions,
                        "warm_same": warm == questions, "cold_ms": cold_ms, "warm_ms": warm_ms})
        print(json.dumps({key: value for key, value in records[-1].items() if key != "context"}, ensure_ascii=False), flush=True)
    output = Path("evaluations/results/suggestions-2026-11-13.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(records, ensure_ascii=False, default=str, indent=2), encoding="utf-8")


def measure_api(env_file):
    """只在 lma_test 中保存合成巡检，测量真实 SQL + HTTP + 模型及暖缓存。"""
    uri = os.environ.get('LMA_TEST_DATABASE_URI', '')
    if not uri.endswith('/lma_test'):
        raise ValueError('API 计时只允许隔离 LMA_TEST_DATABASE_URI，数据库名必须为 lma_test')
    settings = Settings(_env_file=env_file, database_uri=uri)
    with patch('app.config.get_settings', return_value=settings):
        from app.server.api import create_app
    options = {"loop_factory": asyncio.SelectorEventLoop} if sys.platform == "win32" else {}
    asyncio.run(migrate_database(uri), **options)
    app = create_app(settings, agent_factory=lambda saver, storage: None)
    with TestClient(app, backend_options=options) as client:
        storage = app.state.storage
        inspection_id = str(uuid4())

        async def seed():
            await storage.start_inspection(inspection_id)
            row = synthetic_cases()['巡检持续变化']['stations'][0]
            stations = []
            for index in range(6):
                station = SimpleNamespace(station_uuid=str(uuid4()), station_name=f'计时演示点{index}', group_name='合成计时坡体')
                stations.append((station, ScreeningResult('建议调查', row['reasons'], row['metrics'], [0.0] * 90)))
            await storage.save_inspection_stations(inspection_id, stations)
            await storage.finish_inspection(inspection_id, 'success')

        async def cleanup():
            async with storage.pool.connection() as connection:
                await connection.execute('DELETE FROM lma_inspections WHERE id=%s', (inspection_id,))

        client.portal.call(seed)
        try:
            source_times = []
            for _ in range(20):
                start = time.perf_counter()
                client.portal.call(storage.suggestion_sources)
                source_times.append((time.perf_counter() - start) * 1000)
            with patch('app.agent.suggestions.get_settings', return_value=settings):
                start = time.perf_counter()
                cold = client.post('/suggestions').json()
                cold_ms = (time.perf_counter() - start) * 1000
                warm_times = []
                for _ in range(10):
                    start = time.perf_counter()
                    warm = client.post('/suggestions').json()
                    if warm != cold:
                        raise AssertionError('同一摘要版本的结果不同')
                    warm_times.append((time.perf_counter() - start) * 1000)
            result = {'source': 'synthetic_lma_test', 'cold_api_ms': cold_ms,
                      'warm_api_median_ms': statistics.median(warm_times),
                      'warm_api_range_ms': [min(warm_times), max(warm_times)],
                      'source_query_median_ms': statistics.median(source_times),
                      'questions': cold['questions']}
            print(json.dumps(result, ensure_ascii=False), flush=True)
            output = Path('evaluations/results/suggestions-api-2026-11-13.json')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        finally:
            client.portal.call(cleanup)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument('--scenario', action='append', default=[])
    parser.add_argument('--measure-api', action='store_true')
    args = parser.parse_args()
    if args.measure_api:
        measure_api(args.env_file)
    else:
        asyncio.run(evaluate(args.env_file, args.scenario))
