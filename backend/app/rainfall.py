"""测点逐日降雨与强降雨前后的位移速率对比，供测点页直接读取，不经过模型。

降雨来自 Open-Meteo 历史接口（与天气工具同源），是格网再分析资料，不等同于现场雨量计。
强降雨过程按国标 GB/T 28592 日降水量等级识别：日降雨不低于大雨下限的连续日合并为一次过程。
速率对比只陈述过程前后的数值差异，不判断降雨是否导致位移。
"""

import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta

import httpx

from app.open_meteo import ARCHIVE_ENDPOINT, HTTP_TIMEOUT_SECONDS
from app.business_time import BUSINESS_TIMEZONE, TIME_FORMAT
from app.inspection.screening import theil_sen_slope

HEAVY_RAIN_MM = 25.0
RESPONSE_WINDOW_DAYS = 7
_MIN_RATE_POINTS = 4
_MILLIMETERS_PER_METER = 1000.0
_AXIS_NAMES = {"n": "北向", "e": "东向", "u": "垂直"}

_CACHE_SECONDS = 6 * 3600
_cache: dict[tuple, tuple[float, list[dict]]] = {}


@dataclass
class RainEvent:
    start: str
    end: str
    total_mm: float
    peak_mm: float
    antecedent_7d_mm: float | None
    axis: str | None = None
    axis_name: str | None = None
    rate_before_mm_day: float | None = None
    rate_after_mm_day: float | None = None


async def daily_rainfall(latitude: float, longitude: float, start: date, end: date) -> list[dict]:
    """逐日降雨 [{date, value}]，value 缺测时为 None。"""
    key = (round(latitude, 3), round(longitude, 3), start.isoformat(), end.isoformat())
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        return cached[1]
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "timezone": BUSINESS_TIMEZONE,
        "precipitation_unit": "mm",
        "daily": "precipitation_sum",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(ARCHIVE_ENDPOINT, params=params)
    response.raise_for_status()
    daily = response.json().get("daily", {})
    days = [
        {"date": day, "value": value if isinstance(value, (int, float)) else None}
        for day, value in zip(daily.get("time", []), daily.get("precipitation_sum", []))
    ]
    _cache[key] = (time.monotonic(), days)
    return days


def heavy_rain_events(days: list[dict], threshold_mm: float = HEAVY_RAIN_MM) -> list[RainEvent]:
    """日降雨不低于阈值的连续日合并为一次过程，并给出过程前 7 天累计降雨。"""
    events: list[RainEvent] = []
    current: list[dict] = []

    def close():
        if not current:
            return
        first_index = days.index(current[0])
        antecedent = days[max(0, first_index - RESPONSE_WINDOW_DAYS):first_index]
        has_full_antecedent = len(antecedent) == RESPONSE_WINDOW_DAYS and all(day["value"] is not None for day in antecedent)
        events.append(RainEvent(
            start=current[0]["date"],
            end=current[-1]["date"],
            total_mm=round(sum(day["value"] for day in current), 1),
            peak_mm=round(max(day["value"] for day in current), 1),
            antecedent_7d_mm=round(sum(day["value"] for day in antecedent), 1) if has_full_antecedent else None,
        ))
        current.clear()

    for day in days:
        if day["value"] is not None and day["value"] >= threshold_mm:
            current.append(day)
        else:
            close()
    close()
    return events


def _axis_samples(points: list[dict], axis: str) -> list[tuple[datetime, float]]:
    samples = []
    for point in points:
        value = point.get(axis)
        if isinstance(value, (int, float)):
            samples.append((datetime.strptime(point["time"], TIME_FORMAT), value * _MILLIMETERS_PER_METER))
    return samples


def _rate(samples: list[tuple[datetime, float]], begin: datetime, end: datetime) -> float | None:
    window = [(moment, value) for moment, value in samples if begin <= moment <= end]
    if len(window) < _MIN_RATE_POINTS:
        return None
    origin = window[0][0]
    days = [(moment - origin).total_seconds() / 86400 for moment, _ in window]
    return round(theil_sen_slope(days, [value for _, value in window]), 3)


def _main_axis(points: list[dict]) -> str | None:
    """窗口内净变化最大的方向；速率对比只看这一个方向，与曲线上最显眼的那条线一致。"""
    best: tuple[str, float] | None = None
    for axis in ("n", "e", "u"):
        samples = _axis_samples(points, axis)
        if len(samples) < 2:
            continue
        change = abs(samples[-1][1] - samples[0][1])
        if best is None or change > best[1]:
            best = (axis, change)
    return best[0] if best else None


def with_displacement_rates(events: list[RainEvent], points: list[dict]) -> list[RainEvent]:
    """为每次过程补上主方向在过程前 7 天与结束后 7 天的鲁棒速率；观测不足时为 None。"""
    axis = _main_axis(points)
    if axis is None:
        return events
    samples = _axis_samples(points, axis)
    for event in events:
        start = datetime.fromisoformat(event.start)
        end = datetime.fromisoformat(event.end) + timedelta(days=1)
        event.axis = axis
        event.axis_name = _AXIS_NAMES[axis]
        event.rate_before_mm_day = _rate(samples, start - timedelta(days=RESPONSE_WINDOW_DAYS), start)
        event.rate_after_mm_day = _rate(samples, end, end + timedelta(days=RESPONSE_WINDOW_DAYS))
    return events


def rainfall_payload(days: list[dict], events: list[RainEvent]) -> dict:
    return {
        "daily": days,
        "events": [asdict(event) for event in events],
        "threshold_mm": HEAVY_RAIN_MM,
        "source": {"name": "Open-Meteo 历史天气", "url": "https://open-meteo.com/en/docs/historical-weather-api"},
        "limitations": ["格网再分析降雨，不等同于现场雨量计实测；最近几天的资料可能尚未更新。"],
    }
