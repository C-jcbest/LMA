"""测点页的位移序列：直接读取监测平台，不经过模型；与位移工具产物同一结构。"""

from datetime import timedelta

from app.agent.numerical import horizontal_rate_sequence
from app.beidou.schemas import Station
from app.business_time import TIME_FORMAT, business_now
from app.monitoring_data import DISPLACEMENT_STATION_TYPES, MonitoringData, series_artifact_data

TIMELINE_WINDOW_DAYS = (7, 30, 90)
# 一周内看逐小时细节；更长的窗口每天取同一时刻，避免昼夜波动盖住趋势。
_HOURLY_WINDOW_DAYS = 7


async def find_station(data: MonitoringData, station_uuid: str) -> Station | None:
    return next((station for station in await data.stations() if station.station_uuid == station_uuid), None)


async def load_station_series(data: MonitoringData, station: Station, days: int) -> dict | None:
    if station.station_type not in DISPLACEMENT_STATION_TYPES:
        return None
    now = business_now().replace(tzinfo=None)
    sampling = "hourly" if days <= _HOURLY_WINDOW_DAYS else "daily"
    series = await data.displacement(
        station, (now - timedelta(days=days)).strftime(TIME_FORMAT), now.strftime(TIME_FORMAT), sampling,
    )
    # 速率序列供测点页画速率子图，与位移工具同一算法。
    rate_sequence = horizontal_rate_sequence(series.observations, series.sampling, series.cadence_hours)
    return series_artifact_data(series, rate_sequence=rate_sequence)
