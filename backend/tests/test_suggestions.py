"""来源约束、共享生成及摘要失效；全部测点为合成数据。"""

import asyncio
import copy
import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage
from pydantic import ValidationError

from app.agent.suggestions import (
    SuggestionService, suggest_questions, suggestion_context, summary_version,
)
from app.business_time import BUSINESS_TZ


def source_station(identifier="11111111-1111-1111-1111-111111111111", **updates):
    row = {
        "station_uuid": identifier, "station_name": "演示点A", "group_name": "演示坡体",
        "same_name_count": 1, "inspection_id": "synthetic-inspection",
        "inspection_recorded_at": datetime(2026, 11, 12, 16, tzinfo=BUSINESS_TZ),
        "screening": "建议调查", "reasons": ["北向持续同向变化，仍需复核"],
        "metrics": {
            "long_quality": {
                "requested_begin": "2026-08-14 16:00:00", "requested_end": "2026-11-12 16:00:00",
                "expected": 90, "missing": 0, "calendar": {"sample_times": ["15:00"]},
                "axes": {axis: {"valid": 90, "first_valid_time": "2026-08-15 15:00:00",
                                "latest_valid_time": "2026-11-12 15:00:00"} for axis in "neu"},
            },
            "recent_quality": {
                "requested_begin": "2026-11-05 16:00:00", "requested_end": "2026-11-12 16:00:00",
                "expected": 169, "missing": 0, "calendar": {"frequency_minutes": 60},
                "axes": {axis: {"valid": 169, "first_valid_time": "2026-11-05 16:00:00",
                                "latest_valid_time": "2026-11-12 16:00:00"} for axis in "neu"},
            },
            "net_change_mm": {"n": 18, "e": 0, "u": 0},
            "slope_mm_per_day": {"n": 0.2, "e": 0, "u": 0},
        },
        "conclusions": [],
    }
    row.update(updates)
    return row


def question_output(row, question="位移趋势如何？", window="long"):
    return {"station_uuid": row["station_uuid"], "window": window, "question": question}


class SuggestionTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_call_sources_bound_names_windows_and_deduplication(self):
        row = source_station(same_name_count=2)
        item = question_output(row)
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content=json.dumps({"questions": [item, item]}))
        context = suggestion_context({"stations": [row]})
        with patch("app.agent.suggestions._get_suggestion_llm", return_value=model):
            questions = await suggest_questions(context)
        self.assertEqual(len(questions), 1)
        self.assertTrue(questions[0].startswith(f"演示坡体·演示点A（UUID：{row['station_uuid']}） "))
        self.assertTrue(questions[0].endswith("08-14 至 11-12，位移趋势如何？") or questions[0].endswith("2026-08-14 至 2026-11-12，位移趋势如何？"))
        model.ainvoke.assert_awaited_once()
        sent = json.loads(model.ainvoke.call_args.args[0][1].content)
        self.assertEqual(sent["stations"][0]["windows"]["recent"]["quality"]["expected"], 169)
        self.assertEqual(sent["stations"][0]["long_window_metrics"]["net_change_mm"]["n"], 18)

    async def test_unknown_station_or_invented_window_is_discarded(self):
        row = source_station()
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content=json.dumps({"questions": [
            question_output(source_station("fabricated")), question_output(row, window="tomorrow"),
            question_output(row, question="变化与降雨有关吗？"),
        ]}))
        with patch("app.agent.suggestions._get_suggestion_llm", return_value=model):
            result = await suggest_questions(suggestion_context({"stations": [row]}))
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].endswith("变化与降雨有关吗？"))

    async def test_historical_conclusion_uses_observation_period_not_record_date(self):
        row = source_station(screening=None, metrics={}, conclusions=[{
            "status": "未见明显变化", "reason": "该历史窗口平稳", "recorded_at": "2026-11-12",
            "begin_time": "2026-01-01 00:00:00", "end_time": "2026-01-07 00:00:00",
        }])
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content=json.dumps({"questions": [
            question_output(row, question="当时的平稳趋势是否延续？", window="conclusion_0"),
        ]}))
        with patch("app.agent.suggestions._get_suggestion_llm", return_value=model):
            result = await suggest_questions(suggestion_context({"stations": [row]}))
        self.assertRegex(result[0], r"(2026-)?01-01 至 (2026-)?01-07")
        self.assertNotIn("2026-11-12", result[0])

    async def test_question_reads_naturally_without_group_prefix_for_current_window(self):
        today = datetime.now(BUSINESS_TZ).date().isoformat()
        row = source_station()
        row["metrics"]["long_quality"]["requested_begin"] = f"{(datetime.fromisoformat(today) - timedelta(days=90)).date()} 16:00:00"
        row["metrics"]["long_quality"]["requested_end"] = f"{today} 16:00:00"
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content=json.dumps({"questions": [question_output(row)]}))
        with patch("app.agent.suggestions._get_suggestion_llm", return_value=model):
            result = await suggest_questions(suggestion_context({"stations": [row]}))
        self.assertEqual(result, ["演示点A 近 90 天，位移趋势如何？"])

    async def test_all_fabricated_references_are_failure_instead_of_valid_empty_selection(self):
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content=json.dumps({"questions": [
            question_output(source_station('fabricated')),
        ]}))
        with patch('app.agent.suggestions._get_suggestion_llm', return_value=model):
            with self.assertRaisesRegex(ValueError, '没有关联'):
                await suggest_questions(suggestion_context({'stations': [source_station()]}))

    async def test_invalid_output_rejected_and_no_data_needs_no_model(self):
        model = AsyncMock()
        model.ainvoke.return_value = AIMessage(content="模型没有返回JSON")
        with patch("app.agent.suggestions._get_suggestion_llm", return_value=model):
            with self.assertRaises(ValidationError):
                await suggest_questions(suggestion_context({"stations": [source_station()]}))
            result = await suggest_questions(suggestion_context({"stations": []}))
        self.assertEqual(len(result), 2)
        self.assertTrue(all("演示" not in item for item in result))
        model.ainvoke.assert_awaited_once()


class SuggestionCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sources = {"stations": [source_station()]}
        self.storage = AsyncMock()
        self.storage.suggestion_sources.side_effect = lambda: copy.deepcopy(self.sources)
        self.service = SuggestionService()
        self.addAsyncCleanup(self.service.close)

    async def test_concurrent_requests_share_generation_and_warm_cache(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def generate(context):
            started.set()
            await release.wait()
            return ["演示问题"]

        with patch("app.agent.suggestions.suggest_questions", side_effect=generate) as model:
            first = asyncio.create_task(self.service.get(self.storage))
            await started.wait()
            second = asyncio.create_task(self.service.get(self.storage))
            await asyncio.sleep(0)
            release.set()
            self.assertEqual(await asyncio.gather(first, second), [["演示问题"], ["演示问题"]])
            warm = await self.service.get(self.storage)
            warm.append("修改调用方返回值不污染缓存")
            self.assertEqual(await self.service.get(self.storage), ["演示问题"])
            model.assert_awaited_once()

    async def test_changed_summary_day_and_deleted_sources_invalidate(self):
        now = datetime(2026, 11, 13, tzinfo=BUSINESS_TZ)
        with patch("app.agent.suggestions.business_now", return_value=now) as clock:
            with patch("app.agent.suggestions.suggest_questions", return_value=["问题"]) as model:
                await self.service.get(self.storage)
                self.sources["stations"][0]["conclusions"] = [{"reason": "新登记解释"}]
                await self.service.get(self.storage)
                clock.return_value = now + timedelta(days=1)
                await self.service.get(self.storage)
                self.sources["stations"] = []
                await self.service.get(self.storage)
                self.assertEqual(model.await_count, 4)

    async def test_failure_not_cached_but_successful_empty_selection_is_reused(self):
        with patch("app.agent.suggestions.suggest_questions", side_effect=[TimeoutError(), [], ["恢复"]]) as model:
            self.assertEqual(await self.service.get(self.storage), [])
            self.assertEqual(await self.service.get(self.storage), [])
            self.assertEqual(await self.service.get(self.storage), [])
            self.sources['stations'][0]['reasons'].append('新线索')
            self.assertEqual(await self.service.get(self.storage), ["恢复"])
            self.assertEqual(model.await_count, 3)

    async def test_disconnected_waiter_does_not_cancel_shared_generation(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def generate(context):
            started.set()
            await release.wait()
            return ["共享结果"]

        with patch("app.agent.suggestions.suggest_questions", side_effect=generate) as model:
            first = asyncio.create_task(self.service.get(self.storage))
            await started.wait()
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(self.service.get(self.storage))
            release.set()
            self.assertEqual(await second, ["共享结果"])
            model.assert_awaited_once()

    async def test_update_during_generation_is_not_delivered(self):
        async def generate(context):
            self.sources["stations"] = []
            return ["已删除来源的问题"]

        with patch("app.agent.suggestions.suggest_questions", side_effect=generate):
            self.assertEqual(await self.service.get(self.storage), [])

    async def test_shutdown_cancels_pending_generation(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def generate(context):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch("app.agent.suggestions.suggest_questions", side_effect=generate):
            waiter = asyncio.create_task(self.service.get(self.storage))
            await started.wait()
            await self.service.close()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertTrue(cancelled.is_set())

    async def test_generation_deadline_cancels_model_and_allows_next_request(self):
        cancelled = asyncio.Event()

        async def generate(context):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch('app.agent.suggestions._GENERATION_TIMEOUT_SECONDS', 0.01):
            with patch('app.agent.suggestions.suggest_questions', side_effect=generate):
                self.assertEqual(await self.service.get(self.storage), [])
                self.assertTrue(cancelled.is_set())
        with patch('app.agent.suggestions.suggest_questions', return_value=['恢复']) as model:
            self.assertEqual(await self.service.get(self.storage), ['恢复'])
            model.assert_awaited_once()

    async def test_distinct_inflight_versions_are_bounded(self):
        starts = asyncio.Queue()
        release = asyncio.Event()

        async def generate(context):
            await starts.put(True)
            await release.wait()
            return ['问题']

        with patch('app.agent.suggestions.suggest_questions', side_effect=generate) as model:
            first = asyncio.create_task(self.service.get(self.storage))
            await starts.get()
            self.sources['stations'][0]['reasons'] = ['新线索1']
            second = asyncio.create_task(self.service.get(self.storage))
            await starts.get()
            self.sources['stations'][0]['reasons'] = ['新线索2']
            self.assertEqual(await self.service.get(self.storage), [])
            self.assertEqual(model.await_count, 2)
            release.set()
            self.assertEqual(await asyncio.gather(first, second), [[], []])

    async def test_cache_is_bounded_across_versions(self):
        with patch("app.agent.suggestions.suggest_questions", return_value=["问题"]) as model:
            for index in range(10):
                self.sources["stations"][0]["reasons"] = [f"线索{index}"]
                await self.service.get(self.storage)
            self.sources["stations"][0]["reasons"] = ["线索0"]
            await self.service.get(self.storage)
            self.assertEqual(model.await_count, 11)

    def test_version_tracks_quality_and_ignores_dict_order(self):
        context = suggestion_context(self.sources)
        self.assertEqual(summary_version(context), summary_version(dict(reversed(list(context.items())))))
        self.sources["stations"][0]["metrics"]["recent_quality"]["missing"] = 4
        self.assertNotEqual(summary_version(context), summary_version(suggestion_context(self.sources)))
