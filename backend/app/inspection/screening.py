"""巡检初筛：确定性计算 PRD 第 6 节的数值特征，决定哪些测点值得让智能体调查。

初筛只给出调查优先级，不是调查结论，也不是预警。判定以测点自身噪声为基准
（PRD 第 4 节不采用统一形变阈值）；下面的倍数是初筛灵敏度，需用真实数据校准。
"""

import math
from dataclasses import dataclass, field
from datetime import datetime
from statistics import median
from typing import Literal, Sequence

from app.beidou.schemas import GnssDataPoint
from app.business_time import TIME_FORMAT

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


@dataclass
class ScreeningResult:
    screening: Screening
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    trend: list[float | None] = field(default_factory=list)
    trend_directions: dict[str, int] = field(default_factory=dict)


def _to_float(value: str | float | int | None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _point_time(point: GnssDataPoint) -> datetime:
    return datetime.strptime(point.data_time, TIME_FORMAT)


def _axis_series(points: Sequence[GnssDataPoint], axis: str) -> AxisSeries:
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
    return AxisSeries(days, values)


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


def _direction_consistency(values: Sequence[float], slope: float) -> float:
    """按周间隔比较，避免日内和逐日抖动掩盖持续同向变化。"""
    lagged = [values[i + _DIRECTION_LAG_POINTS] - values[i] for i in range(len(values) - _DIRECTION_LAG_POINTS)]
    if not lagged or slope == 0:
        return 0.0
    return sum(1 for change in lagged if change * slope > 0) / len(lagged)


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
        and _direction_consistency(series.values, slope) >= _MIN_DIRECTION_CONSISTENCY
    )
    if is_trending:
        direction = 1 if slope > 0 else -1
        flags.append(f"{name} {span:.0f} 天持续同向变化，约 {total_change:+.1f} mm")

    split_day = series.days[-1] - ACCELERATION_WINDOW_DAYS
    recent = [(day, value) for day, value in zip(series.days, series.values) if day >= split_day]
    earlier = [(day, value) for day, value in zip(series.days, series.values) if day < split_day]
    if len(recent) >= _DIRECTION_LAG_POINTS and len(earlier) >= _DIRECTION_LAG_POINTS:
        recent_slope = theil_sen_slope(*zip(*recent))
        earlier_slope = theil_sen_slope(*zip(*earlier))
        is_faster = abs(recent_slope) >= _ACCELERATION_RATIO * abs(earlier_slope)
        is_significant = abs(recent_slope) * ACCELERATION_WINDOW_DAYS > _TREND_NOISE_MULTIPLE * noise
        if is_faster and is_significant and recent_slope * earlier_slope >= 0:
            flags.append(f"{name}近 {ACCELERATION_WINDOW_DAYS} 天变化快于此前")

    steps = [series.values[i + 1] - series.values[i] for i in range(len(series.values) - 1)]
    if steps:
        step_noise = _robust_sigma(steps)
        largest_index = max(range(len(steps)), key=lambda index: abs(steps[index]))
        largest = steps[largest_index]
        if abs(largest) > _STEP_NOISE_MULTIPLE * step_noise:
            before = series.values[max(0, largest_index - _STEP_PERSISTENCE_POINTS + 1):largest_index + 1]
            after = series.values[largest_index + 1:largest_index + 1 + _STEP_PERSISTENCE_POINTS]
            if abs(median(after) - median(before)) > abs(largest) / 2:
                flags.append(f"{name}出现约 {largest:+.1f} mm 的台阶并保持")
            else:
                notes.append(f"{name}有一次约 {largest:+.1f} mm 的孤立跳变，随后恢复")

    return flags, notes, direction, slope, noise


def _cumulative_offset(points: Sequence[GnssDataPoint], reference: dict[str, float | None]) -> dict | None:
    """相对平台登记的固定初始坐标；缺少基准时不用首点代替，避免混淆两种口径。"""
    latest = {}
    for axis in _AXIS_NAMES:
        value = next((v for v in (_to_float(getattr(p, axis)) for p in reversed(points)) if v is not None), None)
        if value is None or reference.get(axis) is None:
            return None
        latest[axis] = round((value - reference[axis]) * _MILLIMETERS_PER_METER, 1)
    latest["h"] = round(math.hypot(latest["n"], latest["e"]), 1)
    return latest


def _horizontal_trend(north: AxisSeries, east: AxisSeries) -> list[float | None]:
    east_by_day = dict(zip(east.days, east.values))
    return [
        round(math.hypot(value, east_by_day[day]), 2) if day in east_by_day else None
        for day, value in zip(north.days, north.values)
    ]


def screen_station(
    long_points: Sequence[GnssDataPoint],
    recent_points: Sequence[GnssDataPoint],
    reference: dict[str, float | None],
    now: datetime,
) -> ScreeningResult:
    """long_points 为每日固定时刻序列，recent_points 为近期小时序列。"""
    series = {axis: _axis_series(long_points, axis) for axis in _AXIS_NAMES}
    valid_days = min(len(item.values) for item in series.values())
    completeness = round(valid_days / LONG_WINDOW_DAYS, 2)
    metrics: dict = {"valid_days": valid_days, "completeness": completeness}

    if valid_days < _MIN_VALID_DAYS or completeness < _MIN_COMPLETENESS:
        return ScreeningResult(
            "数据不足", [f"近 {LONG_WINDOW_DAYS} 天仅有 {valid_days} 天有效数据，无法判断长期趋势"], metrics,
        )

    flags: list[str] = []
    notes: list[str] = []
    directions: dict[str, int] = {}
    metrics["net_change_mm"] = {}
    metrics["slope_mm_per_day"] = {}
    for axis in _AXIS_NAMES:
        axis_flags, axis_notes, direction, slope, _ = _axis_findings(series[axis], axis)
        flags += axis_flags
        notes += axis_notes
        directions[axis] = direction
        metrics["net_change_mm"][axis] = round(series[axis].values[-1], 1)
        metrics["slope_mm_per_day"][axis] = round(slope, 3)
    metrics["cumulative_offset_mm"] = _cumulative_offset(long_points, reference)

    expected_hours = RECENT_WINDOW_DAYS * 24
    recent_completeness = round(min(len(recent_points) / expected_hours, 1.0), 2)
    metrics["recent_completeness"] = recent_completeness
    latest_time = max((_point_time(point) for point in recent_points), default=None)
    is_stale = latest_time is None or (now - latest_time).total_seconds() > _STALE_AFTER_HOURS * 3600
    data_problems = []
    if is_stale:
        data_problems.append(f"最近 {_STALE_AFTER_HOURS} 小时没有数据")
    elif recent_completeness < _MIN_COMPLETENESS:
        data_problems.append(f"近 {RECENT_WINDOW_DAYS} 天数据完整度 {recent_completeness:.0%}")

    trend = _horizontal_trend(series["n"], series["e"])
    if flags:
        return ScreeningResult("建议调查", [*flags, *data_problems, *notes], metrics, trend, directions)
    if data_problems:
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
