import unittest
from datetime import date, timedelta

from app.rainfall import heavy_rain_events, with_displacement_rates


def _days(values: list[float | None], start: date = date(2026, 10, 1)) -> list[dict]:
    return [{"date": (start + timedelta(days=index)).isoformat(), "value": value} for index, value in enumerate(values)]


def _daily_points(north_mm: list[float], start: date = date(2026, 10, 1)) -> list[dict]:
    """每天 15:00 一个观测，北向按给定毫秒值变化，其余方向不动。"""
    return [
        {"time": f"{(start + timedelta(days=index)).isoformat()} 15:00:00", "n": value / 1000, "e": 0.0, "u": 0.0}
        for index, value in enumerate(north_mm)
    ]


class HeavyRainEventsTest(unittest.TestCase):
    def test_consecutive_heavy_days_merge_into_one_event_with_antecedent_total(self):
        days = _days([1, 2, 0, 3, 0, 4, 5, 30, 40, 2, 26])

        events = heavy_rain_events(days)

        self.assertEqual([(event.start, event.end) for event in events], [("2026-10-08", "2026-10-09"), ("2026-10-11", "2026-10-11")])
        self.assertEqual(events[0].total_mm, 70)
        self.assertEqual(events[0].peak_mm, 40)
        self.assertEqual(events[0].antecedent_7d_mm, 15)

    def test_antecedent_total_is_unknown_when_window_is_short_or_missing(self):
        events = heavy_rain_events(_days([None, 0, 30]))

        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0].antecedent_7d_mm)

    def test_days_below_heavy_rain_do_not_form_events(self):
        self.assertEqual(heavy_rain_events(_days([10, 24.9, None, 0])), [])


class DisplacementRatesTest(unittest.TestCase):
    def test_rates_before_and_after_event_use_main_axis(self):
        north = [index * 0.1 for index in range(10)] + [0.9 + index * 0.5 for index in range(1, 12)]
        events = heavy_rain_events(_days([0] * 9 + [0, 40, 30] + [0] * 9))

        rated = with_displacement_rates(events, _daily_points(north))

        self.assertEqual(rated[0].axis, "n")
        self.assertAlmostEqual(rated[0].rate_before_mm_day, 0.1, places=3)
        self.assertAlmostEqual(rated[0].rate_after_mm_day, 0.5, places=3)

    def test_rate_is_unknown_without_enough_observations_after_event(self):
        events = heavy_rain_events(_days([0] * 8 + [50]))

        rated = with_displacement_rates(events, _daily_points([index * 0.2 for index in range(9)]))

        self.assertIsNotNone(rated[0].rate_before_mm_day)
        self.assertIsNone(rated[0].rate_after_mm_day)


if __name__ == "__main__":
    unittest.main()
