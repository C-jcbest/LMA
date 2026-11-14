"""测点与位移工具：按问题取数，返回模型可直接使用的特征；逐点数据按需提供。"""

import asyncio

from langchain_core.tools import tool

from app.agent.numerical import (
    common_period_features,
    compare_windows,
    horizontal_direction,
    horizontal_rate_sequence,
    window_features,
)
from app.agent.progress import displacement_summary
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
    station_name_matches,
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
        stations = [station for station in stations if station_name_matches(station_name, station.station_name)]
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
        summary=f"找到 {len(stations)} 个测点",
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
    窗口净变化（H、D 为首末偏移模长之差 magnitude_change_mm）、Theil–Sen 鲁棒趋势、最大单步变化与候选跳变
    （是否维持或回落）、缺测前后的位置差、本窗残差离散；按请求采样日历统计的缺测；沿水平主方向的分段速率
    （rate_sequence，看速率是否逐段增大）。可选前后分段比较速率、与同组测点按共同有效时刻对比。

    这些特征由本系统根据平台观测计算，不是监测平台给出的判定。位移单位 mm，速率 mm/day。
    点数较少时附逐点相对位移（dn/de/du）；需要逐条查看、
    自定义统计时把本结果的依据编号交给 compute 计算，不必重新取数。
    """
    async with monitoring() as data:
        station = await data.resolve_station(station_name_or_uuid)
        if station.station_type == BASE_STATION_TYPE:
            return BASE_STATION_NOTE, None
        series = await data.displacement(station, begin_time, end_time, sampling, sample_times)
        group_stations = [
            item for item in await data.stations()
            if item.group_uuid == station.group_uuid and item.station_uuid != station.station_uuid
        ]
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

    rate_sequence = horizontal_rate_sequence(series.observations, series.sampling, series.cadence_hours)
    display = series_artifact_data(
        series, features=features, rate_sequence=rate_sequence, comparisons=comparisons, group_stations=group_stations,
    )
    facts = _model_facts(series, features, rate_sequence, comparisons, include_points)
    return tool_result(
        facts, kind="gnss_series", display=display, observed_at=series.acquired_at,
        summary=displacement_summary(display),
    )


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


def round_mm(value):
    # 位移以 mm 计，0.001 mm 以下只是浮点运算噪声，保留会让模型复述出 1.9999999 这类数字。
    return round(value, 3) if isinstance(value, float) else value


# 合成量 H、D 的“净变化”是首末两点偏移模长之差，不是窗口内位移矢量的长度；换个字段名让含义自明。
_MAGNITUDE_AXES = ("h", "d")


def model_feature(feature: dict, axis: str | None = None) -> dict:
    compact = {
        key: round_mm(feature.get(key))
        for key in _FEATURE_FIELDS_FOR_MODEL if feature.get(key) not in (None, [], "")
    }
    if axis in _MAGNITUDE_AXES and "net_change_mm" in compact:
        compact["magnitude_change_mm"] = compact.pop("net_change_mm")
    gap_shifts = feature.get("gap_shifts") or []
    if gap_shifts:
        compact["gap_shifts"] = [
            {key: round_mm(item[key]) for key in ("gap_from", "gap_to", "gap_hours", "level_shift_mm", "persistence")}
            for item in gap_shifts[:_MAX_EVENTS_FOR_MODEL]
        ]
    events = feature.get("events") or []
    if events:
        compact["events"] = [
            {key: round_mm(event[key]) for key in ("time", "step_mm", "level_shift_mm", "status", "held_until", "held_hours")}
            for event in events[:_MAX_EVENTS_FOR_MODEL]
        ]
    return compact


def model_quality(quality: dict) -> dict:
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


def _model_facts(
    series: DisplacementSeries, features: dict, rate_sequence: dict, comparisons: dict, include_points: bool | None,
) -> dict:
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
        "quality": model_quality(series.quality),
        "features": {axis: model_feature(feature, axis) for axis, feature in features.items()},
    }
    if rate_sequence.get("available"):
        facts["rate_sequence"] = {
            key: rate_sequence[key] for key in ("azimuth_deg", "segment_days", "segments", "pattern", "description")
        }
    north, east = features.get("n", {}), features.get("e", {})
    # 方位与场地坡向（下坡方向）比较，是判断位移是否符合坡体下滑的关键事实；由系统计算，避免模型自行换算角度。
    direction = {
        "cumulative": horizontal_direction(north.get("cum_end_mm"), east.get("cum_end_mm")),
        "window_change": horizontal_direction(north.get("net_change_mm"), east.get("net_change_mm")),
    }
    if any(direction.values()):
        facts["horizontal_direction"] = {
            **{key: value for key, value in direction.items() if value},
            "convention": "方位角从正北顺时针；cumulative 为相对固定参考的累计水平位移，window_change 为本窗口首末水平变化",
        }
    if any(axis in comparisons for axis in features):
        facts["split"] = {
            axis: {
                "first": model_feature(comparison["first"], axis), "second": model_feature(comparison["second"], axis),
                "velocity_difference_mm_day": round_mm(comparison["velocity_difference_mm_day"]),
                "comparison_supported": comparison["comparison_supported"],
            }
            for axis, comparison in comparisons.items() if axis in features
        }
    if "common_period" in comparisons:
        facts["common_period"] = {
            "station_names": comparisons["station_names"],
            "failures": comparisons["failures"],
            "features": {
                axis: {identifier: model_feature(feature, axis) for identifier, feature in by_station.items()}
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
