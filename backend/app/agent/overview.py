"""测点概览：一次取得回答“最近怎么样、稳定吗”所需的基础事实。

状态类问题需要近期小时数据、长期每日数据、同组对比和降雨背景；逐项查询要多次模型往返。
这里只做确定性的数据打包，不规定之后的步骤：模型看完概览再决定是否放大某段、查逐小时降雨或场地。
"""

import asyncio
import logging
from datetime import timedelta

import httpx
from langchain_core.tools import tool

from app.agent.numerical import common_period_features, horizontal_direction, horizontal_rate_sequence, window_features
from app.agent.progress import overview_summary
from app.agent.tool_inputs import StationInput
from app.agent.tool_protocol import tool_result
from app.agent.tools import model_feature, model_quality, round_mm
from app.agent.weather import rainfall_totals
from app.business_time import TIME_FORMAT, business_now
from app.monitoring_data import (
    BASE_STATION_NOTE,
    BASE_STATION_TYPE,
    DISPLACEMENT_STATION_TYPES,
    monitoring,
    series_artifact_data,
    station_summary,
)

RECENT_DAYS = 7
LONG_DAYS = 90
# 同组对比只取近期小时数据；与 get_displacement 的 compare_stations 上限一致。
_MAX_GROUP_STATIONS = 8
_MODEL_AXES = ("n", "e", "u", "h")

logger = logging.getLogger(__name__)


@tool(response_format="content_and_artifact", args_schema=StationInput)
async def get_station_overview(station_name_or_uuid: str):
    """测点概览：一次给出近 7 天小时数据与近 90 天每日 15:00 数据的数值特征（累计偏移、窗口变化、趋势、
    台阶与缺测前后位置差、沿水平主方向的速率序列）、同组移动站近 7 天共同时段的变化，以及近 7、30 天降雨合计。

    适合回答“最近怎么样”“稳定吗”“有没有在动”这类没有指定时间范围的状态问题，也适合作为调查的第一步。
    它只是数据打包：需要放大某段、换窗口、逐小时降雨或场地背景时再用对应工具；同一会话内的位移数据已缓存。
    compute 使用本结果时读取近 7 天小时序列；长期序列的自定义计算请用 get_displacement 取该窗口。
    """
    now = business_now().replace(tzinfo=None, minute=0, second=0, microsecond=0)
    end_time = now.strftime(TIME_FORMAT)
    recent_begin = (now - timedelta(days=RECENT_DAYS)).strftime(TIME_FORMAT)
    long_begin = (now - timedelta(days=LONG_DAYS)).strftime(TIME_FORMAT)

    async with monitoring() as data:
        station = await data.resolve_station(station_name_or_uuid)
        if station.station_type == BASE_STATION_TYPE:
            return BASE_STATION_NOTE, None
        all_stations = await data.stations()
        group_stations = [
            item for item in all_stations
            if item.group_uuid == station.group_uuid and item.station_uuid != station.station_uuid
        ]
        comparable = [item for item in group_stations if item.station_type in DISPLACEMENT_STATION_TYPES]
        comparable = comparable[:_MAX_GROUP_STATIONS]
        recent, long = await asyncio.gather(
            data.displacement(station, recent_begin, end_time, "hourly"),
            data.displacement(station, long_begin, end_time, "daily"),
        )
        others = await asyncio.gather(
            *(data.displacement(item, recent_begin, end_time, "hourly") for item in comparable),
            return_exceptions=True,
        )
    rainfall = await _rainfall(station)

    windows = []
    model_windows = {}
    for label, series in (("long", long), ("recent", recent)):
        features = window_features(series.observations, station, series.begin_time, series.end_time, series.cadence_hours)
        rate_sequence = horizontal_rate_sequence(series.observations, series.sampling, series.cadence_hours)
        windows.append(series_artifact_data(
            series, features=features, rate_sequence=rate_sequence, group_stations=group_stations,
        ))
        model_windows[label] = _model_window(series, features, rate_sequence)

    group = _group_comparison(station, recent, comparable, others)
    facts = {
        "station": {"station_uuid": station.station_uuid, "station_name": station.station_name, "group_name": station.group_name},
        "recent_hourly": model_windows["recent"],
        "long_daily": model_windows["long"],
        "group_recent": group["model"],
        "rainfall": rainfall["model"],
        "note": "近期窗口用于发现新变化或加速，长期窗口用于判断是否处于持续累积；需要细看再按需查询",
    }
    display = {
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "windows": windows,
        "group": group["display"],
        "rainfall": rainfall["display"],
    }
    return tool_result(
        facts, kind="station_overview", display=display, observed_at=recent.acquired_at,
        summary=overview_summary(display),
    )


def _model_window(series, features: dict, rate_sequence: dict) -> dict:
    north, east = features.get("n", {}), features.get("e", {})
    window = {
        "begin_time": series.begin_time, "end_time": series.end_time,
        "sampling": series.sampling, "sample_times": series.sample_times,
        "quality": model_quality(series.quality),
        "features": {axis: model_feature(features[axis], axis) for axis in _MODEL_AXES if axis in features},
    }
    cumulative = horizontal_direction(north.get("cum_end_mm"), east.get("cum_end_mm"))
    window_change = horizontal_direction(north.get("net_change_mm"), east.get("net_change_mm"))
    if cumulative or window_change:
        window["horizontal_direction"] = {
            key: value for key, value in (("cumulative", cumulative), ("window_change", window_change)) if value
        }
    if rate_sequence.get("available"):
        window["rate_sequence"] = {
            key: rate_sequence[key] for key in ("azimuth_deg", "segment_days", "segments", "pattern", "description")
        }
    return window


def _group_comparison(station, recent, comparable, outcomes) -> dict:
    """同组移动站在近期窗口里按共同有效时刻比较各方向的变化，不插值、不错位匹配。"""
    if not comparable:
        return {"model": {"note": "同组没有其他移动站"}, "display": None}
    observations = {station.station_uuid: recent.observations}
    names = {station.station_uuid: station.station_name}
    failures = {}
    for other, outcome in zip(comparable, outcomes):
        names[other.station_uuid] = other.station_name
        if isinstance(outcome, BaseException):
            # 比较站失败不影响主站，只说明没有取得。
            logger.warning("group comparison data request failed", exc_info=outcome)
            failures[other.station_uuid] = "未取得可用数据"
            continue
        observations[other.station_uuid] = outcome.observations
    by_axis = {axis: common_period_features(observations, axis) for axis in ("n", "e", "u")}
    stations = []
    for identifier, name in names.items():
        if identifier in failures:
            continue
        stations.append({
            "station_uuid": identifier,
            "station_name": name,
            "common_samples": by_axis["n"][identifier]["count"],
            "net_change_mm": {axis: round_mm(by_axis[axis][identifier]["net_change_mm"]) for axis in by_axis},
            "robust_slope_mm_day": {axis: round_mm(by_axis[axis][identifier]["robust_slope_mm_day"]) for axis in by_axis},
        })
    comparison = {
        "begin_time": recent.begin_time,
        "end_time": recent.end_time,
        "stations": stations,
        "failures": {names[identifier]: message for identifier, message in failures.items()},
        "method": "各方向只用所有测点共同有效的观测时刻；变化为该共同样本首末之差",
    }
    return {"model": comparison, "display": comparison}


async def _rainfall(station) -> dict:
    summary = station_summary(station)
    latitude, longitude = summary["latitude"], summary["longitude"]
    if latitude is None or longitude is None or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        note = {"available": False, "note": "测点未登记有效经纬度，未取得降雨"}
        return {"model": note, "display": None}
    try:
        totals = await rainfall_totals(latitude, longitude)
    except (httpx.HTTPError, ValueError):
        logger.warning("overview rainfall request failed", exc_info=True)
        note = {"available": False, "note": "天气服务暂不可用，未取得降雨；需要时可单独查询"}
        return {"model": note, "display": None}
    model = {key: value for key, value in totals.items() if key != "daily"}
    return {"model": model, "display": totals}
