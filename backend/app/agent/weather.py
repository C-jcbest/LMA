"""Open-Meteo 天气查询工具，供智能体按需调用。

支持通过监测点名称/UUID 自动解析经纬度，或直接传入经纬度坐标。
字段只取降雨（滑坡监测关心的气象因子；风、气温、湿度与位移对照无关），历史数据走 Archive API，
当前天气与预报走 Forecast API；逐小时降水只在需要时请求。
"""

import asyncio
import logging
from datetime import date, datetime, timedelta
import math

import httpx
from langchain_core.tools import tool
from app.agent.progress import weather_summary
from app.agent.tool_inputs import WeatherInput
from app.agent.tool_protocol import ToolFailure, tool_result

from app.agent.retry import is_transient_error
from app.monitoring_data import monitoring, station_summary
from app.business_time import BUSINESS_TIMEZONE, BUSINESS_TZ, business_now

FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"

HTTP_TIMEOUT_SECONDS = 10
MIN_HISTORY_DATE = date(1940, 1, 1)
MAX_FORECAST_DAYS = 16
MAX_HISTORY_DAYS = 366
DEFAULT_HISTORY_DAYS = 7
MAX_HOURLY_VALUES_FOR_MODEL = 168

CURRENT_FIELDS = ("precipitation", "weather_code")
FORECAST_DAILY_FIELDS = ("precipitation_sum", "precipitation_hours", "precipitation_probability_max")
HISTORY_DAILY_FIELDS = ("precipitation_sum", "precipitation_hours")

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
) -> tuple[float, float, str | None, str | None]:
    """把“站点名/UUID”或经纬度解析为坐标，失败时抛出受控业务异常。"""
    if station_name_or_uuid:
        async with monitoring() as data:
            station = await data.resolve_station(station_name_or_uuid)
        # 与地图、场地查询同一份坐标校验：非法坐标直接说明，不猜测或交换经纬度。
        summary = station_summary(station)
        lat = summary["latitude"]
        lon = summary["longitude"]
        if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ToolFailure(f"监测点 {station.station_name} 未登记有效的 WGS84 经纬度，无法查询天气")
        return lat, lon, station.station_name, station.station_uuid

    if latitude is not None and longitude is not None:
        return float(latitude), float(longitude), None, None

    raise ValueError("weather coordinates not supplied after schema validation")


def _series(payload: dict, group: str, field: str) -> list:
    values = payload.get(group, {}).get(field, [])
    return values if isinstance(values, list) else []


def _sum(values: list) -> float | None:
    numeric = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return round(sum(numeric), 3) if numeric else None


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


def _select_hourly_precipitation(payload: dict) -> dict:
    return {
        "time": _series(payload, "hourly", "time"),
        "precipitation": _series(payload, "hourly", "precipitation"),
    }


@tool(response_format="content_and_artifact", args_schema=WeatherInput)
async def query_weather(
    station_name_or_uuid: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    hourly: bool = False,
    forecast_days: int = 0,
) -> tuple[str, dict]:
    """查询监测点或坐标位置的天气：当前天气、指定历史日期的逐日降雨，可选逐小时降水和未来预报。

    适用于用户询问某天或某段时间的天气、降雨，或气象背景有助于解释已发现的监测现象时。
    历史资料最多到昨天，单次最多 366 天；数据来自公开气象服务，不等同于现场雨量计实测。
    需要按时段统计降雨（例如变化前 3 天累计雨量）时，可把本结果的依据编号交给 compute。
    """
    lat, lon, station_name, station_uuid = await _resolve_coordinates(station_name_or_uuid, latitude, longitude)

    now = business_now()
    today = now.date()
    yesterday = today - timedelta(days=1)
    if start_date is None and end_date is None:
        history_end = yesterday
        history_start = history_end - timedelta(days=DEFAULT_HISTORY_DAYS - 1)
    else:
        history_start = date.fromisoformat(start_date)
        history_end = date.fromisoformat(end_date)
        if history_start < MIN_HISTORY_DATE:
            raise ToolFailure("历史天气最早支持查询至 1940-01-01")
        if history_end >= today:
            raise ToolFailure("历史天气最多只能查询到昨天；今天的情况看当前天气和预报")
        if (history_end - history_start).days + 1 > MAX_HISTORY_DAYS:
            raise ToolFailure(f"历史天气查询跨度不能超过 {MAX_HISTORY_DAYS} 天，请分段查询")

    # 当前天气和最近 24 小时降水都来自预报接口；预报天数至少为 1 才能取得这两项。
    forecast_params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": BUSINESS_TIMEZONE,
        "forecast_days": max(1, forecast_days),
        "past_days": 1,
        "precipitation_unit": "mm",
        "current": ",".join(CURRENT_FIELDS),
        "hourly": "precipitation",
        "daily": ",".join(FORECAST_DAILY_FIELDS),
    }
    history_params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": history_start.isoformat(),
        "end_date": history_end.isoformat(),
        "timezone": BUSINESS_TIMEZONE,
        "precipitation_unit": "mm",
        "daily": ",".join(HISTORY_DAILY_FIELDS),
    }
    if hourly:
        history_params["hourly"] = "precipitation"

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

    current = forecast.get("current", {})
    weather_code = current.get("weather_code")
    recent_24h = _recent_precipitation(forecast, now)
    history_series = {"daily": _select_daily(history, HISTORY_DAILY_FIELDS)}
    if hourly:
        history_series["hourly"] = _select_hourly_precipitation(history)
    forecast_series = {"daily": _select_daily(forecast, FORECAST_DAILY_FIELDS)} if forecast_days > 0 else None

    rain_summary = {
        "recent_24h_precipitation": recent_24h["precipitation"],
        "recent_24h_window": recent_24h,
        "history_total_precipitation": _sum(_series(history, "daily", "precipitation_sum")),
        "history_max_daily_precipitation": _max_daily_item(history, "precipitation_sum"),
    }
    if forecast_series is not None:
        rain_summary.update(
            forecast_total_precipitation=_sum(_series(forecast, "daily", "precipitation_sum")),
            forecast_max_daily_precipitation=_max_daily_item(forecast, "precipitation_sum"),
            forecast_max_precipitation_probability=_max(_series(forecast, "daily", "precipitation_probability_max")),
        )

    data = {
        "ok": True,
        "location": {
            "station_uuid": station_uuid,
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
            "hourly": hourly,
        },
        "units": {"precipitation": "mm"},
        "current": {
            "time": current.get("time"),
            "condition": _WMO_CODES.get(weather_code, f"weather_code={weather_code}") if weather_code is not None else None,
            "precipitation": current.get("precipitation"),
        } if current else None,
        "rain_summary": rain_summary,
        "history": history_series,
        "forecast": forecast_series,
        "source": {"provider": "Open-Meteo"},
    }
    facts = data
    hourly_count = len(history_series.get("hourly", {}).get("time", []))
    if hourly_count > MAX_HOURLY_VALUES_FOR_MODEL:
        # 逐小时序列完整保存在依据中，模型只在需要时通过 compute 读取，避免长序列占满上下文。
        facts = {**data, "history": {
            "daily": history_series["daily"],
            "hourly_note": f"已取得 {hourly_count} 个逐小时降水值，未放入本结果；需要按小时统计时用 compute 读取本依据",
        }}
    return tool_result(facts, kind="weather", display=data, summary=weather_summary(data))


RAINFALL_SUMMARY_DAYS = (7, 30)


async def rainfall_totals(latitude: float, longitude: float) -> dict:
    """测点概览用的降雨合计：截至昨天的近 7、30 天降雨与最大日雨量。

    来自公开气象服务的逐日资料，不等同于现场雨量计；逐小时降雨仍需 query_weather。
    """
    yesterday = business_now().date() - timedelta(days=1)
    start = yesterday - timedelta(days=max(RAINFALL_SUMMARY_DAYS) - 1)
    payload = await _fetch_json(ARCHIVE_ENDPOINT, {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start.isoformat(),
        "end_date": yesterday.isoformat(),
        "timezone": BUSINESS_TIMEZONE,
        "precipitation_unit": "mm",
        "daily": "precipitation_sum",
    })
    dates = _series(payload, "daily", "time")
    values = _series(payload, "daily", "precipitation_sum")
    totals = {}
    for days in RAINFALL_SUMMARY_DAYS:
        recent_values = values[-days:] if len(dates) >= days else []
        totals[f"last_{days}_days_mm"] = _sum(recent_values)
    return {
        "period": {"start_date": start.isoformat(), "end_date": yesterday.isoformat()},
        **totals,
        "max_daily": _max_daily_item(payload, "precipitation_sum"),
        "daily": {"time": dates, "precipitation_sum": values},
        "source": "Open-Meteo 逐日资料，不等同于现场雨量计实测",
    }
