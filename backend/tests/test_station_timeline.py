"""测点页序列与“正在查看的测点”上下文：都不经过模型，也不改用户原文。"""

import unittest
from datetime import timedelta

from langchain_core.messages import HumanMessage

from app.business_time import business_now
from app.agent.message_context import FOCUS_STATION_KEY, model_messages, stamp_user_message
from app.monitoring_data import MonitoringData, _SeriesCache
from app.server.stations import find_station, load_station_series, timeline_window
from test_inspection_api import FakeBeidou, station


def platform_data(client=None):
    client = client or FakeBeidou()
    return MonitoringData(_SeriesCache(), lambda: client)


class StationSeriesTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_window_samples_daily_and_reports_net_change(self):
        series = await load_station_series(platform_data(), station("测试点 A"), timeline_window(90, None, None))

        self.assertEqual(series["station_name"], "测试点 A")
        self.assertEqual(series["sampling"]["sample_times"], ["15:00"])
        self.assertEqual(len(series["points"]), 90)
        self.assertAlmostEqual(series["summary"]["n"]["change"], -0.0178, places=4)
        self.assertEqual(series["summary"]["gaps"], [])

    async def test_week_window_keeps_hourly_points(self):
        series = await load_station_series(platform_data(), station("测试点 A"), timeline_window(7, None, None))

        self.assertEqual(series["sampling"]["mode"], "hourly")
        self.assertEqual(len(series["points"]), 168)

    async def test_base_station_has_no_displacement_series(self):
        data = platform_data()
        base = await find_station(data, "uuid-基准站 R")

        self.assertIsNone(await load_station_series(data, base, timeline_window(90, None, None)))
        self.assertIsNone(await find_station(data, "uuid-不存在"))


class TimelineWindowTests(unittest.TestCase):
    def test_custom_range_covers_whole_days_and_rejects_invalid_ranges(self):
        today = business_now().date()
        window = timeline_window(None, today - timedelta(days=20), today - timedelta(days=10))
        self.assertEqual(window.start.date(), today - timedelta(days=20))
        self.assertEqual((window.end.date(), window.end.hour), (today - timedelta(days=10), 23))

        longest = timeline_window(None, today - timedelta(days=365), today)
        self.assertEqual((longest.end.date() - longest.start.date()).days + 1, 366)

        for days, begin, end in [
            (None, today - timedelta(days=366), today),
            (45, None, None),
            (None, today, today - timedelta(days=1)),
            (None, today - timedelta(days=400), today),
            (None, today, today + timedelta(days=1)),
            (None, today, None),
            (7, today - timedelta(days=3), today),
        ]:
            with self.subTest(days=days, begin=begin, end=end), self.assertRaises(ValueError):
                timeline_window(days, begin, end)


class FocusStationContextTests(unittest.TestCase):
    def test_focus_station_joins_the_snapshot_and_only_the_model_sees_it(self):
        message = HumanMessage(id="q1", content="最近怎么样？", additional_kwargs={FOCUS_STATION_KEY: "测试点 A"})

        stamped = stamp_user_message(message)
        projected = model_messages([stamped])[0]

        self.assertEqual(stamped.content, "最近怎么样？")
        self.assertNotIn(FOCUS_STATION_KEY, stamped.additional_kwargs)
        self.assertEqual(stamped.additional_kwargs["lma_context"]["focus_station"], "测试点 A")
        self.assertIn("focus_station: 测试点 A", projected.content)
        self.assertTrue(projected.content.endswith("最近怎么样？"))

    def test_message_without_focus_keeps_the_original_context_shape(self):
        projected = model_messages([stamp_user_message(HumanMessage(id="q1", content="你好"))])[0]

        self.assertNotIn("focus_station", projected.content)
