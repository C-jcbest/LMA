"""初筛以测点自身噪声判断变化，并如实区分数据不足。"""

import random
import unittest
from datetime import datetime, timedelta

from app.beidou.schemas import GnssDataPoint
from app.inspection.screening import (
    LONG_WINDOW_DAYS,
    ScreeningResult,
    apply_common_mode,
    screen_station,
    theil_sen_slope,
)

NOW = datetime(2026, 11, 9, 16, 0, 0)
REFERENCE = {"n": 100.0, "e": 200.0, "u": 300.0}


def point(moment: datetime, north, east=200.0, up=300.0) -> GnssDataPoint:
    return GnssDataPoint(
        data_time=moment.strftime("%Y-%m-%d %H:%M:%S"),
        n=str(north) if north is not None else "",
        e=str(east), u=str(up),
    )


def daily(north_mm, days=LONG_WINDOW_DAYS, noise_mm=1.5, seed=7):
    """north_mm(i) 给出第 i 天的北向位移（mm），叠加可复现的观测噪声。"""
    rng = random.Random(seed)
    start = (NOW - timedelta(days=days - 1)).replace(hour=15)
    return [
        point(start + timedelta(days=i), 100 + (north_mm(i) + rng.gauss(0, noise_mm)) / 1000,
              200 + rng.gauss(0, noise_mm) / 1000, 300 + rng.gauss(0, noise_mm) / 1000)
        for i in range(days)
    ]


def hourly(hours=7 * 24):
    return [point(NOW - timedelta(hours=hours - i), 100.0) for i in range(hours)]


def screen(long_points, recent_points=None):
    return screen_station(long_points, hourly() if recent_points is None else recent_points, REFERENCE, NOW)


def kinds(result: ScreeningResult, role: str) -> list[str]:
    return [finding.kind for finding in result.findings if finding.role == role]


class ScreeningTests(unittest.TestCase):
    def test_terminal_jump_with_few_observations_is_data_quality_pending_confirmation(self):
        recent = hourly()
        recent[-1] = point(NOW - timedelta(hours=1), 100.1)
        for days in (90, 30):
            with self.subTest(days=days):
                result = screen(daily(lambda i: 0, days=days), recent)
                # 只有少量数据：不作为调查理由，但也不能算未见变化，列为待核查等下次巡检确认。
                self.assertEqual(result.screening, "数据不足")
                self.assertEqual(kinds(result, "trigger"), [])
                self.assertIn("tail_step", kinds(result, "quality"))

    def test_jump_across_gap_with_few_later_observations_is_data_quality(self):
        recent = hourly()
        recent[-1] = point(NOW, 100.1)
        result = screen(daily(lambda i: 0), recent)
        self.assertEqual(result.screening, "数据不足")
        self.assertIn("gap_jump", kinds(result, "quality"))

    def test_daily_terminal_jump_is_not_persistence(self):
        result = screen(daily(lambda i: 0 if i < 89 else 30, noise_mm=0))
        self.assertEqual(result.screening, "数据不足")
        self.assertNotIn("held_step", kinds(result, "trigger"))

    def test_step_held_only_hours_is_data_quality_but_held_days_needs_investigation(self):
        short = hourly()
        for i in range(162, 168):
            short[i] = point(NOW - timedelta(hours=168 - i), 100.05)
        short_result = screen(daily(lambda i: 0), short)
        self.assertEqual(kinds(short_result, "trigger"), [])
        self.assertIn("tail_step", kinds(short_result, "quality"))

        held = hourly()
        for i in range(96, 168):
            held[i] = point(NOW - timedelta(hours=168 - i), 100.05)
        held_result = screen(daily(lambda i: 0), held)
        self.assertEqual(held_result.screening, "建议调查")
        step = next(finding for finding in held_result.findings if finding.kind == "held_step")
        # 只陈述保持了多久，成因留给人调查，不按量级下结论。
        self.assertGreaterEqual(step.days, 2.9)
        self.assertIn("成因需人工调查", step.text)

    def test_hourly_trend_survives_short_history(self):
        recent = [point(NOW - timedelta(hours=168-i), 100 + i * 0.0001) for i in range(168)]
        result = screen(daily(lambda i: 0, days=30), recent)
        self.assertEqual(result.screening, "建议调查")
        self.assertTrue(any("近期小时序列" in reason and "持续同向" in reason for reason in result.reasons))

    def test_duplicate_timestamps_do_not_inflate_coverage(self):
        recent = [hourly()[0]] * 168
        result = screen(daily(lambda i: 0), recent)
        self.assertEqual(result.screening, "数据不足")
        self.assertEqual(result.metrics["recent_completeness"], 0)

    def test_invalid_axis_does_not_hide_other_axis_motion(self):
        recent = [point(NOW - timedelta(hours=168-i), 100 + i * 0.0001, east="") for i in range(168)]
        result = screen(daily(lambda i: 0), recent)
        self.assertEqual(result.screening, "建议调查")
        self.assertEqual(result.metrics["recent_completeness"], 0)

    def test_gap_is_not_a_persistent_step(self):
        recent = hourly()
        recent = recent[:60] + [point(NOW - timedelta(hours=168-i), 100.03) for i in range(100, 168)]
        result = screen(daily(lambda i: 0), recent)
        self.assertNotIn("held_step", kinds(result, "trigger"))
        self.assertTrue(any("缺测" in reason for reason in result.reasons))

    def test_gap_after_candidate_does_not_confirm_persistence(self):
        recent = hourly()
        for i in range(60, 168):
            recent[i] = point(NOW - timedelta(hours=168-i), 100.03)
        del recent[62:100]
        result = screen(daily(lambda i: 0), recent)
        self.assertNotIn("held_step", kinds(result, "trigger"))

    def test_theil_sen_ignores_outliers(self):
        days = [float(i) for i in range(20)]
        values = [0.5 * day for day in days]
        values[10] = 500.0
        self.assertAlmostEqual(theil_sen_slope(days, values), 0.5, places=2)

    def test_quiet_station_is_not_flagged_by_noise(self):
        result = screen(daily(lambda i: 0))
        self.assertEqual(result.screening, "未见明显变化", result.reasons)

    def test_slow_persistent_motion_is_flagged_even_if_last_day_is_small(self):
        result = screen(daily(lambda i: -0.2 * i))
        self.assertEqual(result.screening, "建议调查")
        self.assertTrue(any("北向" in reason and "持续同向" in reason for reason in result.reasons))
        self.assertAlmostEqual(result.metrics["slope_mm_per_day"]["n"], -0.2, delta=0.05)

    def test_threshold_follows_station_noise(self):
        motion = lambda i: -0.05 * i
        self.assertEqual(screen(daily(motion, noise_mm=0.3)).screening, "建议调查")
        self.assertEqual(screen(daily(motion, noise_mm=4)).screening, "未见明显变化")

    def test_recent_acceleration_is_reported(self):
        result = screen(daily(lambda i: -0.05 * i if i < 76 else -3.8 - 0.8 * (i - 76), noise_mm=0.5))
        self.assertTrue(any("快于此前" in reason for reason in result.reasons), result.reasons)

    def test_persistent_step_flags_but_isolated_spike_does_not(self):
        step = screen(daily(lambda i: 0 if i < 50 else 30, noise_mm=0.5))
        self.assertEqual(step.screening, "建议调查")
        self.assertTrue(any("台阶" in reason for reason in step.reasons))

        spike = screen(daily(lambda i: 40 if i == 50 else 0, noise_mm=0.5))
        self.assertEqual(spike.screening, "未见明显变化", spike.reasons)
        self.assertTrue(any("异常跳点" in reason for reason in spike.reasons))
        self.assertEqual([finding.kind for finding in spike.findings if finding.role == "trigger"], [])

    def test_insufficient_history_is_data_problem_not_stability(self):
        result = screen(daily(lambda i: 0, days=10))
        self.assertEqual(result.screening, "数据不足")
        self.assertEqual(result.trend, [])

    def test_missing_values_stay_missing(self):
        points = daily(lambda i: 0)
        for index in range(5, 15):
            points[index] = point(datetime.strptime(points[index].data_time, "%Y-%m-%d %H:%M:%S"), None)
        result = screen(points)
        self.assertEqual(result.metrics["valid_days"], 80)
        # 缺测日不进入趋势，不会被当作 0 位移。
        self.assertEqual(len(result.trend), 80)

    def test_stale_recent_data_is_not_reported_as_stable(self):
        stale = [point(NOW - timedelta(days=5) - timedelta(hours=i), 100.0) for i in range(48)]
        result = screen(daily(lambda i: 0), stale)
        self.assertEqual(result.screening, "数据不足")
        self.assertIn("最近 48 小时没有数据", result.reasons)

    def test_cumulative_offset_uses_fixed_reference_only(self):
        recent = [point(NOW - timedelta(hours=167 - index), 100.012) for index in range(168)]
        result = screen(daily(lambda i: 12, noise_mm=0.5), recent)
        self.assertAlmostEqual(result.metrics["cumulative_offset_mm"]["n"], 12, delta=2)
        self.assertEqual(result.metrics["cumulative_offset_mm"]["observed_at"], NOW.strftime("%Y-%m-%d %H:%M:%S"))
        missing = screen_station(daily(lambda i: 12), hourly(), {"n": None, "e": 200.0, "u": 300.0}, NOW)
        offset = missing.metrics["cumulative_offset_mm"]
        self.assertIsNone(offset['n'])
        self.assertIsNone(offset['h'])
        self.assertEqual(offset['e'], 0)

    def test_screening_coverage_uses_the_same_requested_calendar_as_quality(self):
        recent = hourly()
        result = screen(daily(lambda i: 0), recent)
        quality = result.metrics['recent_quality']
        self.assertEqual(quality['expected'], 169)
        self.assertEqual(result.metrics['recent_completeness'], round(168 / 169, 2))
        self.assertEqual(result.metrics['valid_days'], 90)
        self.assertEqual(result.metrics['long_quality']['axes']['n']['valid'], 90)

    def test_partial_latest_observations_do_not_make_other_axis_cumulative_values_stale(self):
        recent = [point(NOW - timedelta(hours=1), 100.001), point(NOW, 100.012, east='')]
        offset = screen([], recent).metrics['cumulative_offset_mm']
        self.assertEqual(offset['n'], 12)
        self.assertEqual(offset['observed_at_by_metric']['n'], NOW.strftime('%Y-%m-%d %H:%M:%S'))
        self.assertEqual(offset['h'], 1)
        self.assertEqual(offset['observed_at_by_metric']['h'], (NOW - timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S'))

    def test_common_mode_points_to_shared_cause(self):
        moving = [ScreeningResult("建议调查", ["x"], trend_directions={"n": -1, "e": 0, "u": 0}) for _ in range(3)]
        still = ScreeningResult("未见明显变化", [], trend_directions={"n": 0, "e": 0, "u": 0})
        apply_common_mode([*moving, still])
        self.assertTrue(all(any("共同因素" in reason for reason in result.reasons) for result in moving))
        self.assertEqual(still.reasons, [])

        local = [ScreeningResult("建议调查", ["x"], trend_directions={"n": -1, "e": 0, "u": 0})]
        others = [ScreeningResult("未见明显变化", [], trend_directions={"n": 0, "e": 0, "u": 0}) for _ in range(4)]
        apply_common_mode([*local, *others])
        self.assertEqual(local[0].reasons, ["x"])


class InspectionIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_unexpected_station_failure_only_affects_that_station(self):
        import asyncio
        from app.beidou.schemas import Station
        from app.inspection.runner import screen_with_points

        class BrokenClient:
            async def get_daily_data(self, *args, **kwargs):
                raise ValueError("平台返回无法解析的数据")

        station = Station(station_uuid="s", station_name="坏数据站", station_type=3, group_uuid="g", group_name="组")
        result, points = await screen_with_points(BrokenClient(), station, asyncio.Semaphore(1))
        self.assertEqual(points, [])
        self.assertEqual(result.screening, "暂无法分析")
