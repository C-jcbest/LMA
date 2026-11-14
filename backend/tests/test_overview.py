"""测点概览：一次给出近期、长期、同组与降雨，不访问真实平台和天气服务。"""

import json
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from app.agent import overview
from app.beidou.schemas import Station
from app.business_time import business_now
from app.monitoring_data import monitoring_scope
from runtime_fixtures import FakePlatform
from test_inspection_screening import point

STATION = Station(station_uuid='11111111-1111-1111-1111-111111111111', station_name='DEMO-ST03', station_type=3,
                  group_uuid='g', group_name='演示组', station_n0='100', station_e0='200', station_u0='300',
                  latitude='30.5', longitude='103.2')
NEIGHBOUR = Station(station_uuid='22222222-2222-2222-2222-222222222222', station_name='DEMO-ST04', station_type=3,
                    group_uuid='g', group_name='演示组', station_n0='100', station_e0='200', station_u0='300')


def hourly_series(days, rate_mm_per_day):
    now = business_now().replace(tzinfo=None, minute=0, second=0, microsecond=0)
    return [
        point(now - timedelta(hours=hour), 100 - rate_mm_per_day * hour / 24 / 1000)
        for hour in range(days * 24)
    ]


class StationOverviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_overview_packs_recent_long_group_and_rainfall_in_one_result(self):
        platform = FakePlatform([STATION, NEIGHBOUR], {
            STATION.station_uuid: hourly_series(90, 0.5),
            NEIGHBOUR.station_uuid: hourly_series(90, 0.0),
        })
        rainfall = {"period": {"start_date": "x", "end_date": "y"}, "last_7_days_mm": 12.0, "last_30_days_mm": 40.0,
                    "max_daily": None, "daily": {"time": [], "precipitation_sum": []}, "source": "测试"}
        with patch.object(overview, "rainfall_totals", AsyncMock(return_value=rainfall)):
            async with monitoring_scope(None, client_factory=lambda: platform):
                result = await overview.get_station_overview.ainvoke({
                    "type": "tool_call", "id": "ov", "name": "get_station_overview",
                    "args": {"station_name_or_uuid": "ST3"},
                })
        content = json.loads(result.content)
        self.assertEqual(content["station"]["station_name"], "DEMO-ST03")
        self.assertEqual(content["recent_hourly"]["sampling"], "hourly")
        self.assertEqual(content["long_daily"]["sampling"], "daily")
        self.assertAlmostEqual(content["long_daily"]["features"]["n"]["robust_slope_mm_day"], 0.5, delta=0.05)
        self.assertIn("rate_sequence", content["long_daily"])
        names = {item["station_name"] for item in content["group_recent"]["stations"]}
        self.assertEqual(names, {"DEMO-ST03", "DEMO-ST04"})
        self.assertEqual(content["rainfall"]["last_7_days_mm"], 12.0)
        self.assertEqual(result.artifact["kind"], "station_overview")
        self.assertEqual(len(result.artifact["data"]["windows"]), 2)
        self.assertIn("近 7 天降雨 12 mm", result.artifact["summary"])
