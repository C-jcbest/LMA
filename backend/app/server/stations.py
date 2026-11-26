"""测点页的位移序列：直接读取监测平台，不经过模型；与位移工具产物同一结构。"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from app.beidou.schemas import Station
from app.business_time import TIME_FORMAT, business_now
from app.monitoring_data import DISPLACEMENT_STATION_TYPES, MonitoringData, series_artifact_data

TIMELINE_WINDOW_DAYS = (7, 30, 90)
MAX_CUSTOM_WINDOW_DAYS = 366
_HOURLY_WINDOW_DAYS = 7


@dataclass(frozen=True)
class TimelineWindow:
    start: datetime
    end: datetime

    @property
    def days(self) -> float:
        return (self.end - self.start).total_seconds() / 86400


def timeline_window(days: int | None, begin: date | None, end: date | None) -> TimelineWindow:
    """测点页时间窗口：预设天数截至现在，或自定义起止日期（含当天）；不合法时抛 ValueError。"""
    now = business_now().replace(tzinfo=None)
    if begin is None and end is None:
        window_days = 90 if days is None else days
        if window_days not in TIMELINE_WINDOW_DAYS:
            raise ValueError("预设窗口只有 7、30、90 天")
        return TimelineWindow(now - timedelta(days=window_days), now)
    if begin is None or end is None or days is not None:
        raise ValueError("自定义范围需要同时给出起止日期，且不与预设天数混用")
    if begin > end:
        raise ValueError("开始日期不能晚于结束日期")
    clamped_end = min(end, now.date())
    if begin > clamped_end:
        raise ValueError("开始日期不能晚于今天")
    if (clamped_end - begin).days + 1 > MAX_CUSTOM_WINDOW_DAYS:
        raise ValueError(f"自定义范围最长 {MAX_CUSTOM_WINDOW_DAYS} 天（含起止日）")
    return TimelineWindow(datetime.combine(begin, time.min), min(datetime.combine(clamped_end, time.max), now))


async def find_station(data: MonitoringData, station_uuid: str) -> Station | None:
    return next((station for station in await data.stations() if station.station_uuid == station_uuid), None)


async def load_station_series(data: MonitoringData, station: Station, window: TimelineWindow) -> dict | None:
    if station.station_type not in DISPLACEMENT_STATION_TYPES:
        return None
    sampling = "hourly" if window.days <= _HOURLY_WINDOW_DAYS else "daily"
    series = await data.displacement(station, window.start.strftime(TIME_FORMAT), window.end.strftime(TIME_FORMAT), sampling)
    return series_artifact_data(series)
