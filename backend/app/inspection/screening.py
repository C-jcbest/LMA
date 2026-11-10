"""巡检初筛：确定性计算 PRD 第 6 节的数值特征，决定哪些测点值得让智能体调查。

初筛只给出调查优先级，不是调查结论，也不是预警。判定以测点自身噪声为基准
（PRD 第 4 节不采用统一形变阈值）；下面的倍数是初筛灵敏度，需用真实数据校准。
"""

import math
from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from statistics import median
from typing import Literal, Sequence

from app.beidou.schemas import GnssDataPoint
from app.business_time import TIME_FORMAT
from app.observations import finite_number, normalize_observations, observation_quality

Screening = Literal["建议调查", "未见明显变化", "数据不足", "暂无法分析"]

LONG_WINDOW_DAYS = 90
RECENT_WINDOW_DAYS = 7
ACCELERATION_WINDOW_DAYS = 14

_MIN_VALID_DAYS = 14
_MIN_COMPLETENESS = 0.5
_STALE_AFTER_HOURS = 48

_TREND_NOISE_MULTIPLE = 4.0
_STEP_NOISE_MULTIPLE = 6.0
_ACCELERATION_RATIO = 2.0
_MIN_DIRECTION_CONSISTENCY = 0.7
_DIRECTION_LAG_POINTS = 7
_STEP_PERSISTENCE_POINTS = 5
# 工程保护值：序列异常平滑时避免把极小的波动当作显著变化，不代表形变判据。
_NOISE_FLOOR_MM = 0.5

_MILLIMETERS_PER_METER = 1000.0
_ROBUST_SIGMA_FACTOR = 1.4826
_MIN_COMMON_MODE_STATIONS = 3
_COMMON_MODE_SHARE = 0.6

_AXIS_NAMES = {"n": "北向", "e": "东向", "u": "垂直"}


@dataclass
class AxisSeries:
    days: list[float]
    values: list[float]
    cadence_days: float = 1.0


@dataclass
class ScreeningResult:
    screening: Screening
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    trend: list[float | None] = field(default_factory=list)
    trend_directions: dict[str, int] = field(default_factory=dict)


def _to_float(value: str | float | int | None) -> float | None:
    return finite_number(value)


def _point_time(point: GnssDataPoint) -> datetime:
    return datetime.strptime(point.data_time, TIME_FORMAT)


def _axis_series(points: Sequence[GnssDataPoint], axis: str, cadence_days: float = 1.0) -> AxisSeries:
    """相对该方向首个有效值的变化（mm）；缺测点不进入序列。"""
    if not points:
        return AxisSeries([], [])
    start = _point_time(points[0])
    days: list[float] = []
    values: list[float] = []
    first: float | None = None
    for point in points:
        value = _to_float(getattr(point, axis))
        if value is None:
            continue
        first = value if first is None else first
        days.append((_point_time(point) - start).total_seconds() / 86400)
        values.append((value - first) * _MILLIMETERS_PER_METER)
    return AxisSeries(days, values, cadence_days)


def theil_sen_slope(days: Sequence[float], values: Sequence[float]) -> float:
    """每日变化量（mm/day），对异常点稳健。"""
    slopes = [
        (values[j] - values[i]) / (days[j] - days[i])
        for i in range(len(days))
        for j in range(i + 1, len(days))
        if days[j] > days[i]
    ]
    return median(slopes) if slopes else 0.0


def _robust_sigma(values: Sequence[float]) -> float:
    if not values:
        return _NOISE_FLOOR_MM
    center = median(values)
    return max(_ROBUST_SIGMA_FACTOR * median(abs(value - center) for value in values), _NOISE_FLOOR_MM)


def _direction_consistency(series: AxisSeries, slope: float) -> float:
    """按实际时间比较；长窗七天，近期用四分之一窗跨度，不把七点称为一周。"""
    if len(series.days) < 7 or slope == 0:
        return 0.0
    lag_days = min(7.0, (series.days[-1] - series.days[0]) / 4)
    if lag_days < 3 * series.cadence_days:
        return 0.0
    changes = []
    for index, day in enumerate(series.days):
        later = bisect_left(series.days, day + lag_days)
        if later < len(series.days) and series.days[later] - day <= lag_days + series.cadence_days * 1.5:
            changes.append(series.values[later] - series.values[index])
    return sum(change * slope > 0 for change in changes) / len(changes) if changes else 0.0


def _axis_findings(series: AxisSeries, axis: str) -> tuple[list[str], list[str], int, float, float]:
    """返回 (需要调查的线索, 仅作说明的线索, 趋势方向, 斜率, 噪声)。"""
    slope = theil_sen_slope(series.days, series.values)
    residuals = [value - slope * day for day, value in zip(series.days, series.values)]
    noise = _robust_sigma(residuals)
    span = series.days[-1] - series.days[0]
    total_change = slope * span
    name = _AXIS_NAMES[axis]

    flags: list[str] = []
    notes: list[str] = []
    direction = 0
    is_trending = (
        abs(total_change) > _TREND_NOISE_MULTIPLE * noise
        and _direction_consistency(series, slope) >= _MIN_DIRECTION_CONSISTENCY
    )
    if is_trending:
        direction = 1 if slope > 0 else -1
        flags.append(f"{name} {span:.0f} 天持续同向变化，约 {total_change:+.1f} mm")

    comparison_days = min(ACCELERATION_WINDOW_DAYS, span / 2)
    split_day = series.days[-1] - comparison_days
    recent = [(day, value) for day, value in zip(series.days, series.values) if day >= split_day]
    earlier = [(day, value) for day, value in zip(series.days, series.values) if day < split_day]
    if len(recent) >= _DIRECTION_LAG_POINTS and len(earlier) >= _DIRECTION_LAG_POINTS:
        recent_slope = theil_sen_slope(*zip(*recent))
        earlier_slope = theil_sen_slope(*zip(*earlier))
        is_faster = abs(recent_slope) >= _ACCELERATION_RATIO * abs(earlier_slope)
        is_significant = abs(recent_slope) * (recent[-1][0] - recent[0][0]) > _TREND_NOISE_MULTIPLE * noise
        if is_faster and is_significant and recent_slope * earlier_slope >= 0:
            flags.append(f"{name}近 {comparison_days:.1f} 天变化快于此前，仍需分窗复核")

    steps = [series.values[i + 1] - series.values[i] for i in range(len(series.values) - 1)]
    adjacent = [i for i in range(len(steps))
                if 0 < series.days[i + 1] - series.days[i] <= series.cadence_days * 1.5]
    if len(adjacent) != len(steps):
        notes.append(f"{name}存在缺测跨越，跨越差值不作为单步跳变或保持证据")
    for index, change in enumerate(steps):
        if index not in adjacent and abs(change) > _STEP_NOISE_MULTIPLE * noise:
            flags.append(f"{name}缺测两端相差约 {change:+.1f} mm，变化过程待观察")
    if adjacent:
        step_noise = _robust_sigma([steps[i] for i in adjacent])
        largest_index = max(adjacent, key=lambda index: abs(steps[index]))
        largest = steps[largest_index]
        if abs(largest) > _STEP_NOISE_MULTIPLE * step_noise:
            before = series.values[max(0, largest_index - _STEP_PERSISTENCE_POINTS + 1):largest_index + 1]
            after = series.values[largest_index + 1:largest_index + 1 + _STEP_PERSISTENCE_POINTS]
            followup_end = largest_index + len(after)
            continuous = all(i in adjacent for i in range(largest_index, followup_end))
            if len(after) < _STEP_PERSISTENCE_POINTS or not continuous:
                flags.append(f"{name}出现约 {largest:+.1f} mm 的末端跳变，是否保持待观察")
            elif abs(median(after) - median(before)) > abs(largest) / 2:
                flags.append(f"{name}出现约 {largest:+.1f} mm 的台阶并保持")
            else:
                notes.append(f"{name}有一次约 {largest:+.1f} mm 的孤立跳变，随后恢复")

    return flags, notes, direction, slope, noise


def _cumulative_offset(points: Sequence[GnssDataPoint], reference: dict[str, float | None]) -> dict | None:
    """各方向使用自身最新有效观测；合成量只使用同刻有效的分量。"""
    ordered = sorted(points, key=lambda point: point.data_time, reverse=True)
    offsets = {}
    observed_at = {}
    components_by_metric = {
        'n': ('n',), 'e': ('e',), 'u': ('u',),
        'h': ('n', 'e'), 'd': ('n', 'e', 'u'),
    }
    for metric, components in components_by_metric.items():
        offsets[metric] = None
        observed_at[metric] = None
        if any(finite_number(reference.get(axis)) is None for axis in components):
            continue
        latest = next((point for point in ordered
                       if all(_to_float(getattr(point, axis)) is not None for axis in components)), None)
        if latest is None:
            continue
        changes = [(_to_float(getattr(latest, axis)) - finite_number(reference[axis])) * 1000
                   for axis in components]
        value = changes[0] if len(components) == 1 else math.sqrt(sum(change ** 2 for change in changes))
        offsets[metric] = round(value, 1)
        observed_at[metric] = latest.data_time
    valid_times = [time for time in observed_at.values() if time is not None]
    if not valid_times:
        return None
    return {
        **offsets, 'observed_at': max(valid_times), 'observed_at_by_metric': observed_at,
        'baseline': '获取时平台登记的固定初始坐标；未提供历史变更时间',
    }


def _horizontal_trend(north: AxisSeries, east: AxisSeries) -> list[float | None]:
    east_by_day = dict(zip(east.days, east.values))
    return [
        round(math.hypot(value, east_by_day[day]), 2) if day in east_by_day else None
        for day, value in zip(north.days, north.values)
    ]


def _window_points(points: Sequence[GnssDataPoint], start: datetime, end: datetime) -> tuple[list[GnssDataPoint], int]:
    """重复时间无法确定哪个观测可信，整个时间戳剔除，不以输入顺序选值。"""
    normalized, cleaning = normalize_observations(points, start.strftime(TIME_FORMAT), end.strftime(TIME_FORMAT))
    return normalized, cleaning["duplicate_records"]


def screen_station(
    long_points: Sequence[GnssDataPoint],
    recent_points: Sequence[GnssDataPoint],
    reference: dict[str, float | None],
    now: datetime,
) -> ScreeningResult:
    """long_points 为每日固定时刻序列，recent_points 为近期小时序列。"""
    long_points, long_duplicates = _window_points(long_points, now - timedelta(days=LONG_WINDOW_DAYS), now)
    recent_points, recent_duplicates = _window_points(recent_points, now - timedelta(days=RECENT_WINDOW_DAYS), now)
    series = {axis: _axis_series(long_points, axis) for axis in _AXIS_NAMES}
    long_quality = observation_quality(
        long_points, (now - timedelta(days=LONG_WINDOW_DAYS)).strftime(TIME_FORMAT),
        now.strftime(TIME_FORMAT), sample_times=["15:00"],
    )
    recent_quality = observation_quality(
        recent_points, (now - timedelta(days=RECENT_WINDOW_DAYS)).strftime(TIME_FORMAT),
        now.strftime(TIME_FORMAT),
    )
    valid_days = min(axis['valid'] for axis in long_quality['axes'].values())
    completeness = round(valid_days / max(long_quality['expected'], 1), 2)
    metrics: dict = {"valid_days": valid_days, "completeness": completeness}

    flags: list[str] = []
    notes: list[str] = []
    history_insufficient = valid_days < _MIN_VALID_DAYS or completeness < _MIN_COMPLETENESS
    if history_insufficient:
        notes.append(f"近 {LONG_WINDOW_DAYS} 天仅有 {valid_days} 天有效数据，无法判断长期趋势")
    if long_duplicates or recent_duplicates:
        notes.append(f"重复时间已剔除：长期 {long_duplicates} 条，近期 {recent_duplicates} 条")
    directions: dict[str, int] = {}
    metrics["net_change_mm"] = {}
    metrics["slope_mm_per_day"] = {}
    for axis in _AXIS_NAMES:
        if len(series[axis].values) < max(_MIN_VALID_DAYS, LONG_WINDOW_DAYS * _MIN_COMPLETENESS):
            metrics["net_change_mm"][axis] = None
            metrics["slope_mm_per_day"][axis] = None
            continue
        axis_flags, axis_notes, direction, slope, _ = _axis_findings(series[axis], axis)
        flags += axis_flags
        notes += axis_notes
        directions[axis] = direction
        metrics["net_change_mm"][axis] = round(series[axis].values[-1], 1)
        metrics["slope_mm_per_day"][axis] = round(slope, 3)
    metrics["cumulative_offset_mm"] = _cumulative_offset([*long_points, *recent_points], reference)

    for axis in _AXIS_NAMES:
        recent_series = _axis_series(recent_points, axis, 1 / 24)
        if len(recent_series.values) < 2:
            continue
        axis_flags, axis_notes, _, _, _ = _axis_findings(recent_series, axis)
        flags.extend(f"近期小时序列：{reason}" for reason in axis_flags)
        notes.extend(f"近期小时序列：{reason}" for reason in axis_notes)

    valid_hours = min(axis['valid'] for axis in recent_quality['axes'].values())
    recent_completeness = round(valid_hours / max(recent_quality['expected'], 1), 2)
    metrics["recent_completeness"] = recent_completeness
    metrics["recent_quality"] = recent_quality
    metrics["long_quality"] = long_quality
    latest_time = max((_point_time(point) for point in recent_points if any(_to_float(getattr(point, axis)) is not None for axis in _AXIS_NAMES)), default=None)
    is_stale = latest_time is None or (now - latest_time).total_seconds() > _STALE_AFTER_HOURS * 3600
    data_problems = []
    if long_duplicates or recent_duplicates:
        data_problems.append("存在重复时间，需核查数据来源")
    if is_stale:
        data_problems.append(f"最近 {_STALE_AFTER_HOURS} 小时没有数据")
    elif recent_completeness < _MIN_COMPLETENESS:
        data_problems.append(f"近 {RECENT_WINDOW_DAYS} 天数据完整度 {recent_completeness:.0%}")

    trend = [] if history_insufficient else _horizontal_trend(series["n"], series["e"])
    if flags:
        return ScreeningResult("建议调查", [*flags, *data_problems, *notes], metrics, trend, directions)
    if data_problems or history_insufficient:
        return ScreeningResult("数据不足", [*data_problems, *notes], metrics, trend, directions)
    return ScreeningResult("未见明显变化", notes, metrics, trend, directions)


def apply_common_mode(results: Sequence[ScreeningResult]) -> None:
    """同组多数测点同向变化时提示共同因素，局部变化与系统性漂移的处理方向不同。"""
    usable = [result for result in results if result.trend_directions]
    if len(usable) < _MIN_COMMON_MODE_STATIONS:
        return
    for axis, name in _AXIS_NAMES.items():
        for direction in (1, -1):
            moving = [result for result in usable if result.trend_directions.get(axis) == direction]
            if len(moving) >= _MIN_COMMON_MODE_STATIONS and len(moving) / len(usable) >= _COMMON_MODE_SHARE:
                for result in moving:
                    result.reasons.append(f"同组多数测点{name}同向变化，优先核查基准或共同因素")
