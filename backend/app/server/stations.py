"""测点页的位移序列：直接读取监测平台，不经过模型。"""

from datetime import timedelta

from app.agent.tools import _axis_summary
from app.observations import normalize_observations, observation_quality, raw_snapshot
from app.beidou.client import BeidouClient
from app.beidou.schemas import Station
from app.business_time import BUSINESS_TIMEZONE, TIME_FORMAT, business_now

# 2=移动站单点模式，3=移动站RTK模式；基准站和中继站没有形变序列。
_DISPLACEMENT_STATION_TYPES = {2, 3}
TIMELINE_WINDOW_DAYS = (7, 30, 90)
# 一周内看逐小时细节；更长的窗口每天取同一时刻，避免昼夜波动盖住趋势。
_HOURLY_WINDOW_DAYS = 7
_DAILY_SAMPLE_TIMES = ["15:00"]


async def find_station(client: BeidouClient, station_uuid: str) -> Station | None:
    for station in await client.get_stations():
        if station.station_uuid == station_uuid:
            return station
    return None


async def load_station_series(client: BeidouClient, station: Station, days: int) -> dict | None:
    """返回与 GNSS 工具产物相同的序列结构，前端用同一张时间轴绘制。"""
    if station.station_type not in _DISPLACEMENT_STATION_TYPES:
        return None

    now = business_now().replace(tzinfo=None)
    begin_time = (now - timedelta(days=days)).strftime(TIME_FORMAT)
    end_time = now.strftime(TIME_FORMAT)
    sample_times = None if days <= _HOURLY_WINDOW_DAYS else _DAILY_SAMPLE_TIMES
    points = await client.get_daily_data(
        station.station_uuid, begin_time, end_time, sample_times=sample_times,
    )

    original_points = raw_snapshot(points)
    points, cleaning = normalize_observations(points, begin_time, end_time)
    quality = observation_quality(points, begin_time, end_time, sample_times=sample_times, cleaning=cleaning)
    return {
        "quality": quality,
        "raw_points": original_points,
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "begin_time": begin_time,
        "end_time": end_time,
        "timezone": BUSINESS_TIMEZONE,
        "coordinate_unit": "m",
        "summary_unit": "m",
        "total_points": len(points),
        "returned_points": len(points),
        "downsampled": False,
        "sampling": {
            "mode": "sample_times" if sample_times else "hourly",
            "sample_times": sample_times,
            "points_limit": len(points),
        },
        "summary": {
            "n": _axis_summary([point.n for point in points]),
            "e": _axis_summary([point.e for point in points]),
            "u": _axis_summary([point.u for point in points]),
            "gaps": quality["gaps"],
        },
        "points": [
            {"time": point.data_time, "n": point.n, "e": point.e, "u": point.u}
            for point in points
        ],
    }
