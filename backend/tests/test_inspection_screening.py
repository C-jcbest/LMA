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
    start = NOW - timedelta(days=days)
    return [
        point(start + timedelta(days=i), 100 + (north_mm(i) + rng.gauss(0, noise_mm)) / 1000,
              200 + rng.gauss(0, noise_mm) / 1000, 300 + rng.gauss(0, noise_mm) / 1000)
        for i in range(days)
    ]


def hourly(hours=7 * 24):
    return [point(NOW - timedelta(hours=hours - i), 100.0) for i in range(hours)]


def screen(long_points, recent_points=None):
    return screen_station(long_points, hourly() if recent_points is None else recent_points, REFERENCE, NOW)


class ScreeningTests(unittest.TestCase):
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
        self.assertTrue(any("孤立跳变" in reason for reason in spike.reasons))

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
        result = screen(daily(lambda i: 12, noise_mm=0.5))
        self.assertAlmostEqual(result.metrics["cumulative_offset_mm"]["n"], 12, delta=2)
        missing = screen_station(daily(lambda i: 12), hourly(), {"n": None, "e": 200.0, "u": 300.0}, NOW)
        self.assertIsNone(missing.metrics["cumulative_offset_mm"])

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
