"""Open-Meteo 天气查询工具，供智能体按需调用。

支持通过监测点名称/UUID 自动解析经纬度，或直接传入经纬度坐标。
字段选择聚焦降雨与风况（滑坡监测关心的气象因子），历史数据走 Archive API，
预报走 Forecast API。
"""

import asyncio
import logging
from datetime import date, datetime, timedelta
import math

import httpx
from langchain_core.tools import tool
from app.agent.tool_inputs import WeatherInput
from app.agent.tool_protocol import ToolFailure, tool_result

from app.agent.tools import _build_client, _resolve_station
from app.agent.retry import is_transient_error
from app.business_time import BUSINESS_TIMEZONE, BUSINESS_TZ, business_now

FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"

HTTP_TIMEOUT_SECONDS = 10
MIN_HISTORY_DATE = date(1940, 1, 1)
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


async def _fetch_json(endpoint: str, params: dict) -> dict:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(endpoint, params=params)
    response.raise_for_status()
    return response.json()


async def _resolve_coordinates(
    station_name_or_uuid: str | None, latitude: float | None, longitude: float | None
) -> tuple[float, float, str | None]:
    """把“站点名/UUID”或经纬度解析为坐标，失败时抛出受控业务异常。"""
    if station_name_or_uuid:
        async with _build_client() as client:
            station = await _resolve_station(client, station_name_or_uuid)
        try:
            lat = float(station.latitude)
            lon = float(station.longitude)
        except (TypeError, ValueError):
            raise ToolFailure(f"监测点 {station.station_name} 未登记经纬度，无法查询天气")
        # 北斗平台的 Latitude/Longitude 字段存在系统性颠倒（纬度字段存的是经度），
        # 纬度必在 -90~90：若纬度超范围而经度在范围内，则交接后再使用
        if abs(lat) > 90 and abs(lon) <= 90:
            lat, lon = lon, lat
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ToolFailure("监测点未登记有效经纬度，无法查询天气。")
        return lat, lon, station.station_name

    if latitude is not None and longitude is not None:
        return float(latitude), float(longitude), None

    raise ValueError("weather coordinates not supplied after schema validation")


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


@tool(response_format="content_and_artifact", args_schema=WeatherInput)
async def query_weather(
    station_name_or_uuid: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    forecast_days: int = 7,
) -> tuple[str, dict]:
    """查询指定监测点或坐标位置的气象背景。

    可用于用户明确询问天气、降雨、风况、历史气象，
    或 Agent 认为气象信息有助于调查已有监测现象时。
    并非每次监测数据分析都需要调用。

    返回当前天气、指定历史窗口的气象信息以及可用的近期预报。
    气象信息属于辅助证据，不代表其与形变存在因果关系。

    Args:
        station_name_or_uuid: 监测点名称（需能唯一确定）或 36 位 UUID，
            提供后自动解析站点经纬度。与经纬度二选一。
        latitude: 纬度（-90 到 90）。与 longitude 成对提供，与 station_name_or_uuid 二选一。
        longitude: 经度（-180 到 180）。与 latitude 成对提供，与 station_name_or_uuid 二选一。
        start_date: 历史天气开始日期，Asia/Shanghai 业务时区，格式 YYYY-MM-DD，最早支持 1940-01-01。
            与 end_date 成对提供（不传默认查询最近 7 天，最多到昨天）。单次历史查询跨度不超过 31 天。
        end_date: 历史天气结束日期，格式 YYYY-MM-DD，最多只能查询到昨天。与 start_date 跨度不超过 31 天。
        forecast_days: 未来预报天数，取值范围 0 到 16 天（0 表示不查询预报），默认 7 天。
    """
    resolved = await _resolve_coordinates(station_name_or_uuid, latitude, longitude)
    lat, lon, station_name = resolved

    # 历史窗口：默认最近 7 天（截止昨天）
    now = business_now()
    today = now.date()
    yesterday = today - timedelta(days=1)
    if start_date is None and end_date is None:
        history_end = yesterday
        history_start = history_end - timedelta(days=6)
    else:
        history_start = date.fromisoformat(start_date)
        history_end = date.fromisoformat(end_date)
        if history_start < MIN_HISTORY_DATE:
            raise ToolFailure("历史天气最早支持查询至 1940-01-01")
        if history_end >= today:
            raise ToolFailure("历史天气最多只能查询到昨天")
        if (history_end - history_start).days + 1 > MAX_HISTORY_DAYS:
            raise ToolFailure(f"历史天气查询跨度不能超过 {MAX_HISTORY_DAYS} 天")

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
    except httpx.HTTPStatusError as exc:
        logging.getLogger(__name__).warning("weather service rejected request", exc_info=True)
        if is_transient_error(exc):
            raise
        raise ToolFailure("Open-Meteo 拒绝了本次天气查询，请检查参数后重试")
    except (httpx.TimeoutException, httpx.RequestError):
        raise

    if not forecast.get("current") and not _series(forecast, "daily", "time") and not _series(history, "daily", "time"):
        return tool_result(
            {
                "ok": True,
                "location": {
                    "station_name": station_name,
                    "latitude": round(lat, 4),
                    "longitude": round(lon, 4),
                    "timezone": forecast.get("timezone", BUSINESS_TIMEZONE),
                },
                "query": {
                    "timezone": BUSINESS_TIMEZONE,
                    "history_start_date": history_start.isoformat(),
                    "history_end_date": history_end.isoformat(),
                    "forecast_days": forecast_days,
                },
                "message": "天气数据源未返回该位置和时间范围的可用数据。",
            }
        )
    current = forecast.get("current", {})
    weather_code = current.get("weather_code")
    recent_24h = _recent_precipitation(forecast, now)

    return tool_result(
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
