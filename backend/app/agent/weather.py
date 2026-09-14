"""Open-Meteo 天气查询工具，供智能体调用。

仿照 landslide-monitoring-agent 的 query_open_meteo_weather 裁剪为本项目的
极简实现（无缓存/重试基础设施），并增强灵活性：入参支持“监测点名称/UUID”
（自动解析站点经纬度）或直接给经纬度，两种方式二选一。

字段选择聚焦降雨与风况（滑坡监测关心的气象因子），历史数据走 Archive API，
预报走 Forecast API，两者并行请求。
"""

import asyncio
import json
from datetime import date, datetime, timedelta
import math

import httpx
from langchain_core.tools import tool

from app.agent.tools import _build_client, _resolve_station
from app.business_time import BUSINESS_TIMEZONE, BUSINESS_TZ, business_now

FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"

HTTP_TIMEOUT_SECONDS = 10
MAX_FORECAST_DAYS = 16
MAX_HISTORY_DAYS = 31

CURRENT_FIELDS = (
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
)
FORECAST_DAILY_FIELDS = (
    "precipitation_sum",
    "precipitation_hours",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
)
HISTORY_DAILY_FIELDS = (
    "precipitation_sum",
    "precipitation_hours",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
)

# WMO weather code 的简要中文描述，便于直接展示
_WMO_CODES = {
    0: "晴", 1: "基本晴", 2: "局部多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "轻毛毛雨", 53: "毛毛雨", 55: "浓毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
}


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _error(message: str) -> str:
    return _dumps({"ok": False, "message": message})


async def _fetch_json(endpoint: str, params: dict) -> dict:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(endpoint, params=params)
    response.raise_for_status()
    return response.json()


async def _resolve_coordinates(
    station_name_or_uuid: str | None, latitude: float | None, longitude: float | None
) -> tuple[float, float, str | None] | str:
    """把“站点名/UUID”或经纬度解析为坐标，失败时返回提示字符串。"""
    if station_name_or_uuid:
        async with _build_client() as client:
            station = await _resolve_station(client, station_name_or_uuid)
        if isinstance(station, str):
            return station
        try:
            lat = float(station.latitude)
            lon = float(station.longitude)
        except (TypeError, ValueError):
            return f"监测点 {station.station_name} 未登记经纬度，无法查询天气"
        # 北斗平台的 Latitude/Longitude 字段存在系统性颠倒（纬度字段存的是经度），
        # 纬度必在 -90~90：若纬度超范围而经度在范围内，则交接后再使用
        if abs(lat) > 90 and abs(lon) <= 90:
            lat, lon = lon, lat
        return lat, lon, station.station_name

    if latitude is not None and longitude is not None:
        return float(latitude), float(longitude), None

    return "请提供 station_name_or_uuid（监测点名称或 UUID），或同时提供 latitude 和 longitude"


def _parse_date(value: str, field: str) -> date | str:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return f"{field} 格式错误，必须为 YYYY-MM-DD，例如 2026-09-01"


def _series(payload: dict, group: str, field: str) -> list:
    values = payload.get(group, {}).get(field, [])
    return values if isinstance(values, list) else []


def _sum(values: list) -> float:
    return round(sum(v for v in values if isinstance(v, (int, float))), 3)


def _max(values: list):
    numeric = [v for v in values if isinstance(v, (int, float))]
    return max(numeric) if numeric else None


def _max_daily_item(payload: dict, field: str):
    dates = _series(payload, "daily", "time")
    values = _series(payload, "daily", field)
    pairs = [
        (str(dates[i]), float(v))
        for i, v in enumerate(values)
        if i < len(dates) and isinstance(v, (int, float))
    ]
    if not pairs:
        return None
    day, value = max(pairs, key=lambda item: item[1])
    return {"date": day, "value": round(value, 3)}


def _select_daily(payload: dict, fields: tuple[str, ...]) -> dict:
    daily = payload.get("daily", {})
    selected = {"time": daily.get("time", [])}
    for field in fields:
        selected[field] = daily.get(field, [])
    return selected


def _recent_precipitation(payload: dict, now: datetime) -> dict:
    """按小时结束时间取最近 24 个完整小时；缺测不能作为零降雨。"""
    end = now.astimezone(BUSINESS_TZ).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=24)
    expected = {start + timedelta(hours=i) for i in range(1, 25)}
    samples = {}
    for stamp, value in zip(_series(payload, "hourly", "time"), _series(payload, "hourly", "precipitation")):
        try:
            dt = datetime.fromisoformat(stamp)
            dt = dt.replace(tzinfo=BUSINESS_TZ) if dt.tzinfo is None else dt.astimezone(BUSINESS_TZ)
        except (TypeError, ValueError):
            continue
        if dt in expected and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            samples[dt] = value
    return {
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "available_hours": len(samples),
        "expected_hours": 24,
        "complete": len(samples) == 24,
        "precipitation": round(sum(samples.values()), 3) if len(samples) == 24 else None,
        "note": "来自天气服务小时数据；缺测时不输出完整24小时总量，不等同于现场雨量计实测。",
    }


@tool
async def query_weather(
    station_name_or_uuid: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    forecast_days: int = 7,
) -> str:
    """查询天气数据（Open-Meteo），支持按监测点或经纬度灵活查询，返回当前天气、
    历史降雨/风况和未来预报，适用于天气、降雨、风况类问题。

    Args:
        station_name_or_uuid: 监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID，
            提供后自动使用该监测点的经纬度查询其所在位置天气。
        latitude: 纬度（-90 到 90）。与 station_name_or_uuid 二选一。
        longitude: 经度（-180 到 180）。与 latitude 同时提供。
        start_date: 历史天气开始日期，业务时区 Asia/Shanghai，格式 YYYY-MM-DD，与 end_date 同时提供或同时不传
            （不传默认查最近 7 天，最多到昨天）。
        end_date: 历史天气结束日期，格式 YYYY-MM-DD，最多到昨天。
        forecast_days: 预报天数，1 到 16，默认 7。

    返回内容包含：当前天气（气温、天气现象、风）、降雨汇总（近 24 小时、历史合计、
    预报合计及最大日降雨）、风况汇总、按日的历史与预报明细。
    """
    if not 1 <= forecast_days <= MAX_FORECAST_DAYS:
        return _error(f"forecast_days 必须在 1 到 {MAX_FORECAST_DAYS} 之间")
    if latitude is not None or longitude is not None:
        if latitude is None or longitude is None:
            return _error("latitude 和 longitude 必须同时提供")
        if not -90 <= latitude <= 90:
            return _error("latitude 必须在 -90 到 90 之间")
        if not -180 <= longitude <= 180:
            return _error("longitude 必须在 -180 到 180 之间")

    resolved = await _resolve_coordinates(station_name_or_uuid, latitude, longitude)
    if isinstance(resolved, str):
        return _error(resolved)
    lat, lon, station_name = resolved

    # 历史窗口：默认最近 7 天（截止昨天）
    now = business_now()
    today = now.date()
    yesterday = today - timedelta(days=1)
    if start_date is None and end_date is None:
        history_end = yesterday
        history_start = history_end - timedelta(days=6)
    else:
        if start_date is None or end_date is None:
            return _error("start_date 和 end_date 必须同时提供")
        history_start = _parse_date(start_date, "start_date")
        if isinstance(history_start, str):
            return _error(history_start)
        history_end = _parse_date(end_date, "end_date")
        if isinstance(history_end, str):
            return _error(history_end)
        if history_start > history_end:
            return _error("start_date 不能晚于 end_date")
        if history_end >= today:
            return _error("历史天气最多只能查询到昨天")
        if (history_end - history_start).days + 1 > MAX_HISTORY_DAYS:
            return _error(f"历史天气查询跨度不能超过 {MAX_HISTORY_DAYS} 天")

    forecast_params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": BUSINESS_TIMEZONE,
        "forecast_days": forecast_days,
        "past_days": 1,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
        "current": ",".join(CURRENT_FIELDS),
        "hourly": "precipitation",
        "daily": ",".join(FORECAST_DAILY_FIELDS + ("wind_direction_10m_dominant",)),
    }
    history_params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": history_start.isoformat(),
        "end_date": history_end.isoformat(),
        "timezone": BUSINESS_TIMEZONE,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
        "daily": ",".join(HISTORY_DAILY_FIELDS + ("wind_direction_10m_dominant",)),
    }

    try:
        forecast, history = await asyncio.gather(
            _fetch_json(FORECAST_ENDPOINT, forecast_params),
            _fetch_json(ARCHIVE_ENDPOINT, history_params),
        )
    except httpx.HTTPStatusError:
        return _error("Open-Meteo 拒绝了本次天气查询，请检查参数后重试")
    except (httpx.TimeoutException, httpx.RequestError):
        return _error("Open-Meteo 请求超时或暂时不可用，请稍后重试")

    current = forecast.get("current", {})
    weather_code = current.get("weather_code")
    recent_24h = _recent_precipitation(forecast, now)

    return _dumps(
        {
            "ok": True,
            "location": {
                "station_name": station_name,
                "latitude": round(lat, 4),
                "longitude": round(lon, 4),
                "timezone": forecast.get("timezone"),
            },
            "query": {
                "timezone": BUSINESS_TIMEZONE,
                "history_start_date": history_start.isoformat(),
                "history_end_date": history_end.isoformat(),
                "forecast_days": forecast_days,
            },
            "units": {"temperature": "celsius", "wind_speed": "km/h", "precipitation": "mm"},
            "current": {
                "time": current.get("time"),
                "temperature_2m": current.get("temperature_2m"),
                "apparent_temperature": current.get("apparent_temperature"),
                "relative_humidity_2m": current.get("relative_humidity_2m"),
                "condition": _WMO_CODES.get(weather_code, f"weather_code={weather_code}"),
                "precipitation": current.get("precipitation"),
                "wind_speed_10m": current.get("wind_speed_10m"),
                "wind_gusts_10m": current.get("wind_gusts_10m"),
            },
            "rain_summary": {
                "recent_24h_precipitation": recent_24h["precipitation"],
                "recent_24h_window": recent_24h,
                "history_total_precipitation": _sum(
                    _series(history, "daily", "precipitation_sum")
                ),
                "history_max_daily_precipitation": _max_daily_item(
                    history, "precipitation_sum"
                ),
                "forecast_total_precipitation": _sum(
                    _series(forecast, "daily", "precipitation_sum")
                ),
                "forecast_max_daily_precipitation": _max_daily_item(
                    forecast, "precipitation_sum"
                ),
                "forecast_max_precipitation_probability": _max(
                    _series(forecast, "daily", "precipitation_probability_max")
                ),
            },
            "wind_summary": {
                "current_wind_speed": current.get("wind_speed_10m"),
                "current_wind_gust": current.get("wind_gusts_10m"),
                "history_max_wind_speed": _max(
                    _series(history, "daily", "wind_speed_10m_max")
                ),
                "history_max_wind_gust": _max(
                    _series(history, "daily", "wind_gusts_10m_max")
                ),
                "forecast_max_wind_speed": _max(
                    _series(forecast, "daily", "wind_speed_10m_max")
                ),
                "forecast_max_wind_gust": _max(
                    _series(forecast, "daily", "wind_gusts_10m_max")
                ),
            },
            "history": {"daily": _select_daily(history, HISTORY_DAILY_FIELDS)},
            "forecast": {"daily": _select_daily(forecast, FORECAST_DAILY_FIELDS)},
            "source": {"provider": "Open-Meteo"},
        }
    )
