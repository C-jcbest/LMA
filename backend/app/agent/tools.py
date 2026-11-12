"""测点与位移工具：按问题取数，返回模型可直接使用的特征；逐点数据按需提供。"""

import asyncio

from langchain_core.tools import tool

from app.agent.numerical import common_period_features, compare_windows, window_features
from app.agent.tool_inputs import DisplacementInput, FindStationsInput
from app.agent.tool_protocol import ToolFailure, tool_result
from app.config import get_settings
from app.monitoring_data import (
    BASE_STATION_NOTE,
    BASE_STATION_TYPE,
    DISPLACEMENT_STATION_TYPES,
    STATION_STATUS_TEXT,
    DisplacementSeries,
    displacement_mm,
    monitoring,
    series_artifact_data,
    station_summary,
)

_MAX_REQUESTED_POINTS = 1000
_MAX_EVENTS_FOR_MODEL = 5
# 这些字段只服务于复核界面或审计，模型判断不需要，避免占用上下文。
_FEATURE_FIELDS_FOR_MODEL = (
    "metric_name", "count", "begin_time", "end_time", "effective_span_hours", "baseline",
    "cum_start_mm", "cum_end_mm", "net_change_mm", "robust_slope_mm_day", "trend_supported",
    "residual_noise_mm", "max_step_mm", "max_step_time", "level_shift_mm", "jump_persistence",
    "event_count", "limitations",
)


@tool(response_format="content_and_artifact", args_schema=FindStationsInput)
async def find_stations(group_name: str | None = None, station_name: str | None = None, station_status: str | None = None):
    """查询有权访问的监测点分组与测点：名称、分组、类型（基准站/移动站）、状态、WGS84 坐标。

    条件都不传时返回全部分组和测点。分组请求得到整个分组的测点集合；基准站与中继站没有形变序列。
    """
    async with monitoring() as data:
        groups = await data.groups()
        stations = await data.stations()
    if group_name:
        matched = [group for group in groups if group_name in group.group_name]
        exact = [group for group in matched if group.group_name == group_name]
        if len(exact) == 1:
            matched = exact
        if not matched:
            raise ToolFailure(f"未找到名称包含“{group_name}”的分组")
        if len(matched) > 1:
            raise ToolFailure(f"匹配到 {len(matched)} 个分组，请确认具体分组：" + "、".join(group.group_name for group in matched[:20]))
        groups = matched
        stations = [station for station in stations if station.group_uuid == matched[0].group_uuid]
    if station_name:
        stations = [station for station in stations if station_name in station.station_name]
    if station_status:
        stations = [station for station in stations if STATION_STATUS_TEXT.get(station.station_status) == station_status]
    return tool_result(
        {
            "total": len(stations),
            "groups": [
                {"group_name": group.group_name, "station_count": group.station_count, "description": group.description}
                for group in groups
            ],
            "stations": [station_summary(station) for station in stations],
        },
        kind="station_list",
    )


@tool(response_format="content_and_artifact", args_schema=DisplacementInput)
async def get_displacement(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    sampling: str = "hourly",
    sample_times: list[str] | None = None,
    split_time: str | None = None,
    compare_stations: list[str] | None = None,
    include_points: bool | None = None,
):
    """查询移动站任意时间窗的 GNSS 位移，并直接给出数值特征。

    每个方向（北向 N、东向 E、垂向 U、水平合成 H、三维合成 D）给出：相对平台固定参考的累计偏移、
    窗口净变化、Theil–Sen 鲁棒趋势、最大单步变化与候选跳变（是否维持或回落）、本窗残差离散；
    以及按请求采样日历统计的缺测。可选前后分段比较速率、与同组测点按共同有效时刻对比。

    这些特征由本系统根据平台观测计算，不是监测平台给出的判定。位移单位 mm，速率 mm/day。
    点数较少时附逐点相对位移（dn/de/du）；需要逐条查看、
    自定义统计时把本结果的依据编号交给 compute 计算，不必重新取数。
    """
    async with monitoring() as data:
        station = await data.resolve_station(station_name_or_uuid)
        if station.station_type == BASE_STATION_TYPE:
            return BASE_STATION_NOTE, None
        series = await data.displacement(station, begin_time, end_time, sampling, sample_times)
        others = []
        for identifier in dict.fromkeys(compare_stations or []):
            other = await data.resolve_station(identifier)
            if other.station_uuid == station.station_uuid:
                continue
            if other.group_uuid != station.group_uuid or other.station_type not in DISPLACEMENT_STATION_TYPES:
                raise ToolFailure(f"{other.station_name} 不是同组移动站，不能做共同时段对比")
            others.append(other)
        outcomes = await asyncio.gather(
            *(data.displacement(other, begin_time, end_time, sampling, series.sample_times) for other in others),
            return_exceptions=True,
        )

    features = window_features(series.observations, station, begin_time, end_time, series.cadence_hours)
    comparisons = {}
    if split_time:
        comparisons.update(_split_comparison(series, split_time))
    if others:
        comparisons.update(_station_comparison(series, others, outcomes))

    display = series_artifact_data(series, features=features, comparisons=comparisons)
    facts = _model_facts(series, features, comparisons, include_points)
    return tool_result(facts, kind="gnss_series", display=display, observed_at=series.acquired_at)


def _split_comparison(series: DisplacementSeries, split_time: str) -> dict:
    station = series.station
    first = [point for point in series.observations if point.data_time < split_time]
    second = [point for point in series.observations if point.data_time >= split_time]
    first_features = window_features(first, station, series.begin_time, split_time, series.cadence_hours, "first_window")
    second_features = window_features(second, station, split_time, series.end_time, series.cadence_hours, "second_window")
    return {axis: compare_windows(first_features[axis], second_features[axis]) for axis in first_features}


def _station_comparison(series: DisplacementSeries, others, outcomes) -> dict:
    observations = {series.station.station_uuid: series.observations}
    names = {series.station.station_uuid: series.station.station_name}
    failures = {}
    for other, outcome in zip(others, outcomes):
        names[other.station_uuid] = other.station_name
        if isinstance(outcome, BaseException):
            # 比较站失败不影响主站结论，但不能拿其他站代替它。
            failures[other.station_uuid] = "未取得可用数据"
            observations[other.station_uuid] = []
        else:
            observations[other.station_uuid] = outcome.observations
    return {
        "common_period": {
            axis: common_period_features(observations, axis, cadence_hours=series.cadence_hours)
            for axis in ("n", "e", "u")
        },
        "station_names": names,
        "failures": failures,
        "snapshots": {
            identifier: [point.as_dict() for point in points] for identifier, points in observations.items()
        },
    }


def _rounded(value):
    # 位移以 mm 计，0.001 mm 以下只是浮点运算噪声，保留会让模型复述出 1.9999999 这类数字。
    return round(value, 3) if isinstance(value, float) else value


def _model_feature(feature: dict) -> dict:
    compact = {
        key: _rounded(feature.get(key))
        for key in _FEATURE_FIELDS_FOR_MODEL if feature.get(key) not in (None, [], "")
    }
    events = feature.get("events") or []
    if events:
        compact["events"] = [
            {key: _rounded(event[key]) for key in ("time", "step_mm", "level_shift_mm", "status", "held_until", "held_hours")}
            for event in events[:_MAX_EVENTS_FOR_MODEL]
        ]
    return compact


def _model_quality(quality: dict) -> dict:
    return {
        "expected_samples": quality["expected"],
        "missing_samples": quality["missing"],
        "axes": {axis: {"valid": item["valid"], "missing": item["missing"]} for axis, item in quality["axes"].items()},
        "gap_count": quality["gap_count"],
        "gaps": [
            {key: gap[key] for key in ("from", "to", "missing_count", "boundary")}
            for gap in quality["gaps"][:10]
        ],
    }


def _model_facts(series: DisplacementSeries, features: dict, comparisons: dict, include_points: bool | None) -> dict:
    station = series.station
    facts = {
        "station": {
            "station_uuid": station.station_uuid, "station_name": station.station_name, "group_name": station.group_name,
        },
        "window": {
            "begin_time": series.begin_time, "end_time": series.end_time,
            "sampling": series.sampling, "sample_times": series.sample_times, "acquired_at": series.acquired_at,
        },
        "reference": {
            axis: "平台固定参考" if value is not None else "固定参考缺失，累计偏移未知"
            for axis, value in series.reference.items()
        },
        "quality": _model_quality(series.quality),
        "features": {axis: _model_feature(feature) for axis, feature in features.items()},
    }
    if any(axis in comparisons for axis in features):
        facts["split"] = {
            axis: {
                "first": _model_feature(comparison["first"]), "second": _model_feature(comparison["second"]),
                "velocity_difference_mm_day": _rounded(comparison["velocity_difference_mm_day"]),
                "comparison_supported": comparison["comparison_supported"],
            }
            for axis, comparison in comparisons.items() if axis in features
        }
    if "common_period" in comparisons:
        facts["common_period"] = {
            "station_names": comparisons["station_names"],
            "failures": comparisons["failures"],
            "features": {
                axis: {identifier: _model_feature(feature) for identifier, feature in by_station.items()}
                for axis, by_station in comparisons["common_period"].items()
            },
        }

    count = len(series.observations)
    inline_limit = get_settings().agent_inline_points_limit
    if include_points is True and count > _MAX_REQUESTED_POINTS:
        raise ToolFailure(f"本窗口共 {count} 点，逐点返回最多 {_MAX_REQUESTED_POINTS} 点；请缩小窗口，或用 compute 计算所需统计")
    if include_points is True or (include_points is None and count <= inline_limit):
        facts["points"] = [
            {"time": point.data_time, **displacement_mm(point, series.reference)} for point in series.observations
        ]
        facts["points_unit"] = "mm，相对平台固定参考"
    else:
        facts["points_note"] = f"共 {count} 个有效时刻未逐点返回；需要逐条数值时缩小窗口、传 include_points，或用 compute 计算"
    return facts
