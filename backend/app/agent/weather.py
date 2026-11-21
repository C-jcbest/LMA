"""Open-Meteo 天气查询工具，供智能体按需调用。

支持通过监测点名称/UUID 自动解析经纬度，或直接传入经纬度坐标。
字段选择聚焦降雨、气温、降雪与风况（滑坡监测关心的气象因子）。历史数据走 Archive API，
当前天气与预报走 Forecast API；两者相互独立，一个失败时保留另一个并说明缺失。逐小时降水只在需要时请求。
"""

import asyncio
import logging
from dataclasses import asdict
from datetime import date, datetime, timedelta
import math

import httpx
from langchain_core.tools import tool
from app.agent.tool_inputs import WeatherInput
from app.agent.tool_protocol import ToolFailure, ToolInputError, tool_result

from app.agent.retry import is_transient_error
from app.monitoring_data import MAX_WINDOW_DAYS, monitoring, series_artifact_data, station_coordinates
from app.open_meteo import ARCHIVE_ENDPOINT, FORECAST_ENDPOINT, HTTP_TIMEOUT_SECONDS
from app.rainfall import HEAVY_RAIN_MM, RESPONSE_WINDOW_DAYS, heavy_rain_events, with_displacement_rates
from app.business_time import BUSINESS_TIMEZONE, BUSINESS_TZ, TIME_FORMAT, business_now


DEFAULT_HISTORY_DAYS = 7
MAX_HOURLY_VALUES_FOR_MODEL = 168

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
    "temperature_2m_max",
    "temperature_2m_min",
    "snowfall_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
)

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
    """把“站点名/UUID”或经纬度解析为坐标；测点坐标的颠倒判定与地图、场地分析共用同一规则。"""
    if station_name_or_uuid is None:
        return float(latitude), float(longitude), None, None
    async with monitoring() as data:
        station = await data.resolve_station(station_name_or_uuid)
    station_latitude, station_longitude = station_coordinates(station)
    if station_latitude is None:
        raise ToolFailure(f"监测点 {station.station_name} 未登记有效经纬度，无法查询天气")
    return station_latitude, station_longitude, station.station_name, station.station_uuid


async def _fetch_part(endpoint: str, params: dict, label: str) -> tuple[dict | None, BaseException | None]:
    """单独请求一类资料；失败只记录日志，由调用方决定是否整体失败。"""
    try:
        return await _fetch_json(endpoint, params), None
    except (httpx.HTTPError, ValueError) as error:
        logging.getLogger(__name__).warning("weather %s request failed", label, exc_info=True)
        return None, error


def _raise_unavailable(error: BaseException):
    """两类资料都没有取得时整体失败；瞬时故障交给官方工具重试。"""
    if is_transient_error(error):
        raise error
    raise ToolFailure("Open-Meteo 拒绝了本次天气查询，请检查参数后重试")


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
    }


def _select_hourly_precipitation(payload: dict) -> dict:
    return {
        "time": _series(payload, "hourly", "time"),
        "precipitation": _series(payload, "hourly", "precipitation"),
    }


def _today_hourly_precipitation(payload: dict, today: date) -> dict:
    """当天逐小时降水：已过去的小时来自当前观测，之后的小时是预报。"""
    prefix = today.isoformat()
    pairs = [
        (stamp, value)
        for stamp, value in zip(_series(payload, "hourly", "time"), _series(payload, "hourly", "precipitation"))
        if str(stamp).startswith(prefix)
    ]
    return {"time": [stamp for stamp, _ in pairs], "precipitation": [value for _, value in pairs]}


async def _rain_events_with_rates(
    station_uuid: str, daily: dict, history_start: date, history_end: date,
) -> tuple[list[dict], str | None]:
    """强降雨过程与测点主方向前后速率；与测点页同一算法（app/rainfall.py），取每日固定时刻位移。"""
    days = [
        {"date": day, "value": value if isinstance(value, (int, float)) else None}
        for day, value in zip(daily.get("time", []), daily.get("precipitation_sum") or [])
    ]
    events = heavy_rain_events(days)
    if not events:
        return [], None
    now = business_now().replace(tzinfo=None)
    begin = datetime.combine(history_start - timedelta(days=RESPONSE_WINDOW_DAYS), datetime.min.time())
    end = min(datetime.combine(history_end + timedelta(days=RESPONSE_WINDOW_DAYS + 1), datetime.min.time()), now)
    if (end - begin).days > MAX_WINDOW_DAYS["daily"]:
        return [asdict(event) for event in events], "历史期间过长，未计算降雨前后的位移速率；缩短到一年以内可得到"
    async with monitoring() as data:
        station = await data.resolve_station(station_uuid)
        series = await data.displacement(station, begin.strftime(TIME_FORMAT), end.strftime(TIME_FORMAT), "daily")
    points = series_artifact_data(series)["points"]
    return [asdict(event) for event in with_displacement_rates(events, points)], None


@tool(response_format="content_and_artifact", args_schema=WeatherInput)
async def query_weather(
    station_name_or_uuid: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    hourly: bool = False,
    forecast_days: int = 0,
    rain_response: bool = False,
) -> tuple[str, dict]:
    """查询监测点或坐标位置的天气：当前天气、指定历史日期的逐日降雨/气温/降雪与风况，可选逐小时降水和未来预报。

    适用于用户询问某天或某段时间的天气、降雨，或气象背景有助于解释已发现的监测现象时。
    历史资料最多到昨天，单次最多 366 天，与位移小时级取数上限相同，可一次取得整个位移窗口对应的天气，不必分段；hourly 为 true 时同时给出历史和当天的逐小时降水（当天未来时刻为预报）。
    当前天气与历史资料分别来自两个接口，其中一个不可用时结果会说明缺了哪一部分。
    数据来自公开气象服务，不等同于现场雨量计实测。
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
        if history_end >= today:
            raise ToolInputError("历史天气最多只能查询到昨天；今天的情况看当前天气、hourly 逐小时降水和预报")

    forecast_params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": BUSINESS_TIMEZONE,
        "forecast_days": max(1, forecast_days),
        "past_days": 1,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
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
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
        "daily": ",".join(HISTORY_DAILY_FIELDS),
    }
    if hourly:
        history_params["hourly"] = "precipitation"

    (forecast, forecast_error), (history, history_error) = await asyncio.gather(
        _fetch_part(FORECAST_ENDPOINT, forecast_params, "forecast"),
        _fetch_part(ARCHIVE_ENDPOINT, history_params, "archive"),
    )
    if forecast is None and history is None:
        _raise_unavailable(history_error)
    limitations = []
    if forecast is None:
        limitations.append("当前天气、最近 24 小时降水与预报暂不可用")
        forecast = {}
    if history is None:
        limitations.append(f"{history_start.isoformat()} 至 {history_end.isoformat()} 的历史逐日资料暂不可用")
        history = {}

    current = forecast.get("current", {})
    weather_code = current.get("weather_code")
    history_series = {"daily": _select_daily(history, HISTORY_DAILY_FIELDS)}
    if hourly:
        history_series["hourly"] = _select_hourly_precipitation(history)
    forecast_series = {"daily": _select_daily(forecast, FORECAST_DAILY_FIELDS)} if forecast_days > 0 and forecast else None

    rain_summary = {
        "history_total_precipitation": _sum(_series(history, "daily", "precipitation_sum")),
        "history_max_daily_precipitation": _max_daily_item(history, "precipitation_sum"),
    }
    if forecast:
        recent_24h = _recent_precipitation(forecast, now)
        rain_summary.update(recent_24h_precipitation=recent_24h["precipitation"], recent_24h_window=recent_24h)
    wind_summary = {
        "current_wind_speed": current.get("wind_speed_10m"),
        "current_wind_gust": current.get("wind_gusts_10m"),
        "history_max_wind_speed": _max(_series(history, "daily", "wind_speed_10m_max")),
        "history_max_wind_gust": _max(_series(history, "daily", "wind_gusts_10m_max")),
    }
    if forecast_series is not None:
        rain_summary.update(
            forecast_total_precipitation=_sum(_series(forecast, "daily", "precipitation_sum")),
            forecast_max_daily_precipitation=_max_daily_item(forecast, "precipitation_sum"),
            forecast_max_precipitation_probability=_max(_series(forecast, "daily", "precipitation_probability_max")),
        )
        wind_summary.update(
            forecast_max_wind_speed=_max(_series(forecast, "daily", "wind_speed_10m_max")),
            forecast_max_wind_gust=_max(_series(forecast, "daily", "wind_gusts_10m_max")),
        )

    data = {
        "ok": True,
        "location": {
            "station_uuid": station_uuid,
            "station_name": station_name,
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "timezone": forecast.get("timezone") or history.get("timezone"),
        },
        "query": {
            "timezone": BUSINESS_TIMEZONE,
            "history_start_date": history_start.isoformat(),
            "history_end_date": history_end.isoformat(),
            "forecast_days": forecast_days,
            "hourly": hourly,
        },
        "units": {"temperature": "celsius", "wind_speed": "km/h", "precipitation": "mm"},
        "current": {
            "time": current.get("time"),
            "temperature_2m": current.get("temperature_2m"),
            "apparent_temperature": current.get("apparent_temperature"),
            "relative_humidity_2m": current.get("relative_humidity_2m"),
            "condition": _WMO_CODES.get(weather_code, f"weather_code={weather_code}") if weather_code is not None else None,
            "precipitation": current.get("precipitation"),
            "wind_speed_10m": current.get("wind_speed_10m"),
            "wind_gusts_10m": current.get("wind_gusts_10m"),
        } if current else None,
        "rain_summary": rain_summary,
        "wind_summary": wind_summary,
        "history": history_series,
        "today_hourly": _today_hourly_precipitation(forecast, today) if hourly and forecast else None,
        "forecast": forecast_series,
        "source": {"provider": "Open-Meteo"},
    }
    if rain_response and station_uuid and history:
        events, note = await _rain_events_with_rates(station_uuid, history_series["daily"], history_start, history_end)
        data["rain_events"] = events
        data["rain_threshold_mm"] = HEAVY_RAIN_MM
        if note:
            limitations.append(note)
    facts = {**data, "limitations": limitations} if limitations else data
    hourly_count = len(history_series.get("hourly", {}).get("time", []))
    if hourly_count > MAX_HOURLY_VALUES_FOR_MODEL:
        facts = {**facts, "history": {
            "daily": history_series["daily"],
            "hourly_note": f"已取得 {hourly_count} 个逐小时降水值，未放入本结果；需要按小时统计时用 compute 读取本依据",
        }}
    return tool_result(
        facts, kind="weather", display=data,
        status="partial" if limitations else "success",
        limitations=limitations or None,
    )
