"""巡检初筛：确定性计算产品规则（docs/product/rules.md）第 6 节的数值特征，决定哪些测点值得让智能体调查。

初筛只给出调查优先级，不是调查结论，也不是预警。判定以测点自身噪声为基准
（产品规则第 4 节不采用统一形变阈值）；下面的倍数是初筛灵敏度，需用真实数据校准。

原因直接展示给监测人员，所以先按方向得到结构化线索，再按测点合并成一两句业务语言。
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
from app.series_features import (
    GAP_SHIFT_SIGMAS,
    NOISE_FLOOR_MM,
    HorizontalSeries,
    RateSegment,
    gap_level_shifts,
    is_adjacent,
    main_direction,
    point_noise,
    rate_pattern,
    rate_sequence,
    robust_sigma,
    theil_sen_slope,
)

Screening = Literal["建议调查", "未见明显变化", "数据不足", "暂无法分析"]
Window = Literal["long", "recent"]

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

# 速率序列：长期按周、近期按天切段，各看最近几段的走势。
_RATE_SEGMENT_DAYS: dict[Window, float] = {"long": 7.0, "recent": 1.0}
_RATE_MAX_SEGMENTS: dict[Window, int] = {"long": 6, "recent": 7}
_RATE_SEGMENT_LABEL: dict[Window, str] = {"long": "周", "recent": "天"}
_WINDOW_DAYS: dict[Window, int] = {"long": LONG_WINDOW_DAYS, "recent": RECENT_WINDOW_DAYS}
_CADENCE_DAYS: dict[Window, float] = {"long": 1.0, "recent": 1 / 24}

_MILLIMETERS_PER_METER = 1000.0
_MIN_COMMON_MODE_STATIONS = 3
_COMMON_MODE_SHARE = 0.6

_AXIS_NAMES = {"n": "北向", "e": "东向", "u": "垂直"}


@dataclass
class AxisSeries:
    start: datetime | None
    days: list[float]
    values: list[float]
    cadence_days: float = 1.0

    def moment(self, day: float) -> datetime:
        return self.start + timedelta(days=day)


@dataclass
class ScreeningResult:
    screening: Screening
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    trend: list[float | None] = field(default_factory=list)
    trend_directions: dict[str, int] = field(default_factory=dict)


@dataclass
class _Finding:
    """一条按方向得到的线索；needs_investigation 为 False 的只作说明。"""
    kind: Literal["gap_shift", "step", "unsettled_jump", "spike", "faster", "trend", "accelerating"]
    window: Window
    axis: str | None = None
    value_mm: float | None = None
    at: datetime | None = None
    until: datetime | None = None
    held: bool | None = None
    ratio: float | None = None
    rates: list[float] = field(default_factory=list)
    needs_investigation: bool = True


def _to_float(value: str | float | int | None) -> float | None:
    return finite_number(value)


def _point_time(point: GnssDataPoint) -> datetime:
    return datetime.strptime(point.data_time, TIME_FORMAT)


def _axis_series(points: Sequence[GnssDataPoint], axis: str, cadence_days: float = 1.0) -> AxisSeries:
    """相对该方向首个有效值的变化（mm）；缺测点不进入序列。"""
    if not points:
        return AxisSeries(None, [], [], cadence_days)
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
    return AxisSeries(start, days, values, cadence_days)


def _horizontal_series(points: Sequence[GnssDataPoint]) -> tuple[datetime | None, HorizontalSeries]:
    """北、东同时有效的时刻；相对首个同时有效值的变化（mm）。"""
    series = HorizontalSeries([], [], [])
    start = None
    first = None
    for point in points:
        north = _to_float(point.n)
        east = _to_float(point.e)
        if north is None or east is None:
            continue
        moment = _point_time(point)
        if first is None:
            start = moment
            first = (north, east)
        series.days.append((moment - start).total_seconds() / 86400)
        series.north.append((north - first[0]) * _MILLIMETERS_PER_METER)
        series.east.append((east - first[1]) * _MILLIMETERS_PER_METER)
    return start, series


def _noise_with_floor(value: float | None) -> float:
    return max(value if value is not None else 0.0, NOISE_FLOOR_MM)


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


def _axis_findings(series: AxisSeries, axis: str, window: Window) -> tuple[list[_Finding], int, float]:
    """返回 (线索, 趋势方向, 斜率)。"""
    slope = theil_sen_slope(series.days, series.values)
    residuals = [value - slope * day for day, value in zip(series.days, series.values)]
    noise = _noise_with_floor(robust_sigma(residuals))
    span = series.days[-1] - series.days[0]
    total_change = slope * span

    findings: list[_Finding] = []
    direction = 0
    is_trending = (
        abs(total_change) > _TREND_NOISE_MULTIPLE * noise
        and _direction_consistency(series, slope) >= _MIN_DIRECTION_CONSISTENCY
    )
    if is_trending:
        direction = 1 if slope > 0 else -1
        # 判定用鲁棒趋势，原因里写窗口首末的实际变化：与首页行内的数字和迷你曲线是同一个量。
        findings.append(_Finding("trend", window, axis, value_mm=series.values[-1]))

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
            # 此前的变化本身在噪声以内时倍数没有意义，改说“此前基本平稳”。
            earlier_movement = abs(earlier_slope) * (earlier[-1][0] - earlier[0][0])
            ratio = abs(recent_slope / earlier_slope) if earlier_movement > 2 * noise else None
            findings.append(_Finding("faster", window, axis, value_mm=comparison_days, ratio=ratio))

    # 缺测前后位置差与相邻单步分开判断：跨越缺测的差值不当作单步跳变。
    adjacent_noise = _noise_with_floor(point_noise(series.days, series.values, series.cadence_days))
    for shift in gap_level_shifts(series.days, series.values, series.cadence_days, slope,
                                  adjacent_noise, GAP_SHIFT_SIGMAS):
        findings.append(_Finding(
            "gap_shift", window, axis, value_mm=shift.shift_mm,
            at=series.moment(shift.before_day), until=series.moment(shift.after_day), held=shift.held,
        ))

    steps = [series.values[i + 1] - series.values[i] for i in range(len(series.values) - 1)]
    adjacent = [i for i in range(len(steps)) if is_adjacent(series.days[i], series.days[i + 1], series.cadence_days)]
    if adjacent:
        step_noise = _noise_with_floor(robust_sigma([steps[i] for i in adjacent]))
        largest_index = max(adjacent, key=lambda index: abs(steps[index]))
        largest = steps[largest_index]
        if abs(largest) > _STEP_NOISE_MULTIPLE * step_noise:
            moment = series.moment(series.days[largest_index + 1])
            before = series.values[max(0, largest_index - _STEP_PERSISTENCE_POINTS + 1):largest_index + 1]
            after = series.values[largest_index + 1:largest_index + 1 + _STEP_PERSISTENCE_POINTS]
            followup_end = largest_index + len(after)
            continuous = all(i in adjacent for i in range(largest_index, followup_end))
            if len(after) < _STEP_PERSISTENCE_POINTS or not continuous:
                findings.append(_Finding("unsettled_jump", window, axis, value_mm=largest, at=moment))
            elif abs(median(after) - median(before)) > abs(largest) / 2:
                findings.append(_Finding("step", window, axis, value_mm=largest, at=moment))
            else:
                findings.append(_Finding("spike", window, axis, value_mm=largest, at=moment, needs_investigation=False))

    return findings, direction, slope


def _rate_findings(points: Sequence[GnssDataPoint], window: Window) -> tuple[list[_Finding], dict | None]:
    """沿水平主方向的速率序列；最近三段逐段增大时提示加速。"""
    start, horizontal = _horizontal_series(points)
    direction = main_direction(horizontal)
    if direction is None:
        return [], None
    azimuth, along = direction
    cadence = _CADENCE_DAYS[window]
    segments = rate_sequence(horizontal.days, along, cadence, _RATE_SEGMENT_DAYS[window], _RATE_MAX_SEGMENTS[window])
    pattern = rate_pattern(segments)
    metric = {
        "segment_days": _RATE_SEGMENT_DAYS[window],
        "azimuth_deg": round(azimuth, 1),
        "pattern": pattern,
        "segments": [_segment_metric(segment, start) for segment in segments],
    }
    latest = segments[-1] if segments else None
    is_meaningful = (
        latest is not None and latest.rate_mm_day is not None and latest.uncertainty_mm_day is not None
        and abs(latest.rate_mm_day) > 2 * latest.uncertainty_mm_day
    )
    if pattern != "逐段增大" or not is_meaningful:
        return [], metric
    rates = [abs(segment.rate_mm_day) for segment in segments[-3:]]
    return [_Finding("accelerating", window, rates=rates)], metric


def _segment_metric(segment: RateSegment, start: datetime) -> dict:
    return {
        "begin_time": (start + timedelta(days=segment.start_day)).strftime(TIME_FORMAT),
        "end_time": (start + timedelta(days=segment.end_day)).strftime(TIME_FORMAT),
        "rate_mm_day": None if segment.rate_mm_day is None else round(segment.rate_mm_day, 3),
        "uncertainty_mm_day": None if segment.uncertainty_mm_day is None else round(segment.uncertainty_mm_day, 3),
        "count": segment.count,
    }


def _moment_text(moment: datetime, window: Window) -> str:
    return moment.strftime("%m-%d %H:%M" if window == "recent" else "%m-%d")


def _gap_duration_text(before: datetime, after: datetime, window: Window) -> str:
    """缺测时长：前后两个有效观测之间少了的那段时间，不含两端观测本身。"""
    hours = (after - before).total_seconds() / 3600 - _CADENCE_DAYS[window] * 24
    if hours < 48:
        return f"约 {hours:.0f} 小时"
    return f"约 {hours / 24:.0f} 天"


def _axis_values(findings: Sequence[_Finding]) -> str:
    return "、".join(f"{_AXIS_NAMES[finding.axis]} {finding.value_mm:+.1f} mm" for finding in findings)


def _horizontal_total(findings: Sequence[_Finding]) -> str:
    by_axis = {finding.axis: finding.value_mm for finding in findings}
    if "n" in by_axis and "e" in by_axis:
        return f"（水平约 {math.hypot(by_axis['n'], by_axis['e']):.1f} mm）"
    return ""


def _grouped(findings: Sequence[_Finding], key) -> list[list[_Finding]]:
    groups: dict = {}
    for finding in findings:
        groups.setdefault(key(finding), []).append(finding)
    return list(groups.values())


def _compose_reasons(findings: Sequence[_Finding]) -> tuple[list[str], list[str]]:
    """把各方向的线索合并成业务语言；返回 (需要调查的原因, 仅作说明的附注)。

    顺序即重要程度：位置突变 → 加速 → 变快 → 持续变化。
    """
    reasons: list[str] = []
    notes: list[str] = []

    def of_kind(kind):
        return [finding for finding in findings if finding.kind == kind]

    for group in _grouped(of_kind("gap_shift"), lambda finding: (finding.window, finding.at)):
        first = group[0]
        if first.held is True:
            followup = "，之后一直保持"
        elif first.held is False:
            followup = "，之后未保持在新位置"
        else:
            followup = "，缺测后观测还少，是否保持待观察"
        reasons.append(
            f"{_moment_text(first.at + timedelta(days=_CADENCE_DAYS[first.window]), first.window)} 起缺测{_gap_duration_text(first.at, first.until, first.window)}，"
            f"前后位置{_axis_values(group)}{followup}"
        )
    for group in _grouped(of_kind("step"), lambda finding: (finding.window, finding.at.date())):
        reasons.append(f"{_moment_text(group[0].at, group[0].window)} 出现台阶并保持：{_axis_values(group)}")
    for group in _grouped(of_kind("unsettled_jump"), lambda finding: (finding.window, finding.at.date())):
        reasons.append(f"{_moment_text(group[0].at, group[0].window)} 跳变：{_axis_values(group)}，之后观测不足，是否保持待观察")
    for finding in of_kind("accelerating"):
        unit = _RATE_SEGMENT_LABEL[finding.window]
        rates = " → ".join(f"{rate:.2f}" if rate < 1 else f"{rate:.1f}" for rate in finding.rates)
        reasons.append(f"近 3 {unit}水平速率逐段增大：{rates} mm/day")
    for group in _grouped(of_kind("faster"), lambda finding: finding.window):
        axes = "、".join(_AXIS_NAMES[finding.axis] for finding in group)
        ratios = [finding.ratio for finding in group if finding.ratio is not None]
        if len(ratios) == len(group):
            comparison = f"约为此前 {min(ratios):.0f} 倍"
        else:
            comparison = "此前基本平稳"
        reasons.append(f"近 {group[0].value_mm:.0f} 天{axes}明显变快（{comparison}）")
    for group in _grouped(of_kind("trend"), lambda finding: finding.window):
        days = _WINDOW_DAYS[group[0].window]
        reasons.append(f"近 {days} 天持续同向变化：{_axis_values(group)}{_horizontal_total(group)}")
    for group in _grouped(of_kind("spike"), lambda finding: (finding.window, finding.at.date())):
        axes = "、".join(_AXIS_NAMES[finding.axis] for finding in group)
        notes.append(f"{_moment_text(group[0].at, group[0].window)} {axes}有一次孤立跳变，随后恢复")
    return reasons, notes


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

    findings: list[_Finding] = []
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
        axis_findings, direction, slope = _axis_findings(series[axis], axis, "long")
        findings += axis_findings
        directions[axis] = direction
        metrics["net_change_mm"][axis] = round(series[axis].values[-1], 1)
        metrics["slope_mm_per_day"][axis] = round(slope, 3)
    metrics["cumulative_offset_mm"] = _cumulative_offset([*long_points, *recent_points], reference)

    for axis in _AXIS_NAMES:
        recent_series = _axis_series(recent_points, axis, _CADENCE_DAYS["recent"])
        if len(recent_series.values) < 2:
            continue
        axis_findings, _, _ = _axis_findings(recent_series, axis, "recent")
        findings += axis_findings

    metrics["rate_sequence"] = {}
    if not history_insufficient:
        rate_findings, rate_metric = _rate_findings(long_points, "long")
        findings += rate_findings
        metrics["rate_sequence"]["long"] = rate_metric
    rate_findings, rate_metric = _rate_findings(recent_points, "recent")
    findings += rate_findings
    metrics["rate_sequence"]["recent"] = rate_metric

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

    flagged, finding_notes = _compose_reasons([finding for finding in findings if finding.needs_investigation])
    _, spike_notes = _compose_reasons([finding for finding in findings if not finding.needs_investigation])
    notes = [*notes, *finding_notes, *spike_notes]
    trend = [] if history_insufficient else _horizontal_trend(series["n"], series["e"])
    if flagged:
        return ScreeningResult("建议调查", [*flagged, *data_problems, *notes], metrics, trend, directions)
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
