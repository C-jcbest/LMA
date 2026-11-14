"""位移序列的共用数值原语：巡检初筛与智能体位移工具使用同一套口径。

输入都是按时间排序、已剔除缺测的序列：days 为相对首点的天数，values 为 mm。
不对缺测插值；跨越缺测的两点不当作相邻观测。
"""

import math
from dataclasses import dataclass
from statistics import median
from typing import Literal, Sequence

ROBUST_SIGMA_FACTOR = 1.4826
# 工程保护值：序列异常平滑（如合成数据、平台补值）时避免把极小的波动当作显著变化。
NOISE_FLOOR_MM = 0.5
# 判断两点是否相邻：间隔不超过采样间隔的 1.5 倍。
ADJACENT_CADENCE_FACTOR = 1.5

# 缺测前后各取至多 5 个有效点求位置中位数，至少 3 个点才比较。
_GAP_LEVEL_POINTS = 5
_GAP_MIN_POINTS = 3
_MEDIAN_EFFICIENCY = 1.2533
# 缺测前后位置差超过两中位数之差不确定度的这一倍数才列出；初筛与位移工具共用。
GAP_SHIFT_SIGMAS = 5.0
# 速率段内有效点至少为应有点数的一半，且不少于 4 个。
_RATE_MIN_COVERAGE = 0.5
_RATE_MIN_POINTS = 4
# 首末两段速率差超过两者合成不确定度的 2 倍，才算“增大/减小”。
_RATE_CHANGE_SIGMAS = 2.0
_RATE_PATTERN_SEGMENTS = 3
_SLOPE_SAMPLE_LIMIT = 300

RatePattern = Literal["逐段增大", "逐段减小", "未见逐段增减", "样本不足"]


def theil_sen_slope(days: Sequence[float], values: Sequence[float]) -> float:
    """每日变化量（mm/day），对异常点稳健。"""
    slopes = [
        (values[j] - values[i]) / (days[j] - days[i])
        for i in range(len(days))
        for j in range(i + 1, len(days))
        if days[j] > days[i]
    ]
    return median(slopes) if slopes else 0.0


def sampled_slope(days: Sequence[float], values: Sequence[float]) -> float:
    """长序列等索引抽样后求 Theil–Sen 斜率，避免点对数量随样本平方增长。"""
    count = len(days)
    if count <= _SLOPE_SAMPLE_LIMIT:
        return theil_sen_slope(days, values)
    indices = sorted({round(i * (count - 1) / (_SLOPE_SAMPLE_LIMIT - 1)) for i in range(_SLOPE_SAMPLE_LIMIT)})
    return theil_sen_slope([days[i] for i in indices], [values[i] for i in indices])


def robust_sigma(values: Sequence[float]) -> float | None:
    if not values:
        return None
    center = median(values)
    return ROBUST_SIGMA_FACTOR * median(abs(value - center) for value in values)


def is_adjacent(earlier_day: float, later_day: float, cadence_days: float) -> bool:
    return 0 < later_day - earlier_day <= cadence_days * ADJACENT_CADENCE_FACTOR


def point_noise(days: Sequence[float], values: Sequence[float], cadence_days: float) -> float | None:
    """由相邻观测差估计单点噪声（差值离散 / √2）。

    相邻差几乎不受缓慢趋势和一次台阶影响；用整窗残差估计时，台阶本身会把噪声抬高，反而把台阶掩盖掉。
    """
    differences = [
        values[index + 1] - values[index]
        for index in range(len(days) - 1)
        if is_adjacent(days[index], days[index + 1], cadence_days)
    ]
    if len(differences) < 5:
        return None
    return robust_sigma(differences) / math.sqrt(2)


@dataclass
class GapShift:
    before_day: float
    """缺测前最后一个有效观测。"""
    after_day: float
    """缺测后第一个有效观测。"""
    shift_mm: float
    """扣除整窗趋势后，缺测后位置相对缺测前的变化。"""
    held: bool | None
    """之后是否一直保持在新位置；缺测后观测太少时为 None。"""


def _median_difference_sigma(noise: float, before_count: int, after_count: int) -> float:
    """两组中位数之差的标准差：正态噪声下中位数的标准差约为均值的 1.2533 倍。"""
    return _MEDIAN_EFFICIENCY * noise * math.sqrt(1 / before_count + 1 / after_count)


def gap_level_shifts(
    days: Sequence[float],
    values: Sequence[float],
    cadence_days: float,
    slope: float,
    noise: float,
    sigmas: float,
) -> list[GapShift]:
    """缺测前后的位置差。

    强降雨、断电、通信中断往往和真实位移同时发生，缺测期间变化过程未知，所以不判“单步跳变”；
    但缺测前后位置差明显超出噪声时，仍是需要提示的事实。按整窗趋势扣除缺测期间本应发生的变化，
    避免把缓慢蠕变在长缺测上的累积当成位置突变。

    显著性看“两个中位数之差”的不确定度，而不是单点噪声：各取 5 点的中位数比单点稳定得多，
    用单点噪声的倍数会把与噪声同量级的真实台阶（如噪声 1.5 mm 下的 9 mm 台阶）漏掉。
    """
    residuals = [value - slope * day for day, value in zip(days, values)]
    shifts = []
    for index in range(len(days) - 1):
        if is_adjacent(days[index], days[index + 1], cadence_days):
            continue
        before = residuals[max(0, index - _GAP_LEVEL_POINTS + 1):index + 1]
        after = residuals[index + 1:index + 1 + _GAP_LEVEL_POINTS]
        # 缺测后只剩一两个点时，通常就是最新观测：变化刚出现，最需要提示，按“待观察”给出。
        reaches_latest = index + 1 + len(after) == len(residuals)
        if len(before) < _GAP_MIN_POINTS or (len(after) < _GAP_MIN_POINTS and not reaches_latest):
            continue
        before_level = median(before)
        shift = median(after) - before_level
        if abs(shift) <= sigmas * _median_difference_sigma(noise, len(before), len(after)):
            continue
        held = None
        if len(after) == _GAP_LEVEL_POINTS:
            latest_level = median(residuals[-_GAP_LEVEL_POINTS:])
            held = (latest_level - before_level) * math.copysign(1, shift) >= abs(shift) / 2
        shifts.append(GapShift(days[index], days[index + 1], shift, held))
    return shifts


@dataclass
class RateSegment:
    start_day: float
    end_day: float
    rate_mm_day: float | None
    """段内有效点不足时为 None。"""
    uncertainty_mm_day: float | None
    count: int


def rate_sequence(
    days: Sequence[float],
    values: Sequence[float],
    cadence_days: float,
    segment_days: float,
    max_segments: int,
) -> list[RateSegment]:
    """从最新观测向前按固定步长切段，每段用 Theil–Sen 求速率，按时间先后返回。

    不确定度按等间隔采样下最小二乘斜率的标准误近似：噪声 × √(12 / 点数) / 段跨度。
    它只用于判断相邻两段的差异是否超出噪声，不是严格的置信区间。
    """
    if len(days) < 2:
        return []
    noise = point_noise(days, values, cadence_days)
    if noise is None:
        noise = robust_sigma([value - sampled_slope(days, values) * day for day, value in zip(days, values)]) or 0.0
    # 序列异常平滑时，浮点误差级的速率差也会“超出不确定度”；给噪声一个工程下限，不代表形变判据。
    noise = max(noise, NOISE_FLOOR_MM)
    expected_points = segment_days / cadence_days
    minimum_points = max(_RATE_MIN_POINTS, math.ceil(expected_points * _RATE_MIN_COVERAGE))
    segments: list[RateSegment] = []
    end = days[-1]
    while len(segments) < max_segments and end - segment_days >= days[0] - cadence_days / 2:
        start = end - segment_days
        indices = [index for index, day in enumerate(days) if start < day <= end]
        if len(indices) >= minimum_points:
            segment_days_list = [days[index] for index in indices]
            segment_values = [values[index] for index in indices]
            span = segment_days_list[-1] - segment_days_list[0]
            rate = theil_sen_slope(segment_days_list, segment_values)
            uncertainty = noise * math.sqrt(12 / len(indices)) / span if span > 0 else None
            segments.append(RateSegment(start, end, rate, uncertainty, len(indices)))
        else:
            segments.append(RateSegment(start, end, None, None, len(indices)))
        end = start
    return list(reversed(segments))


def rate_pattern(segments: Sequence[RateSegment]) -> RatePattern:
    """看最近三段：同向、逐段不减（或不增），且首末两段之差超出两者合成不确定度的 2 倍。

    相邻两段各自的差异在噪声下常常不显著，所以显著性看首末两段，中间段只要求不逆向超出一个不确定度。
    """
    latest = list(segments[-_RATE_PATTERN_SEGMENTS:])
    if len(latest) < _RATE_PATTERN_SEGMENTS or any(
        segment.rate_mm_day is None or segment.uncertainty_mm_day is None for segment in latest
    ):
        return "样本不足"
    direction = math.copysign(1, latest[-1].rate_mm_day)
    speeds = [segment.rate_mm_day * direction for segment in latest]
    uncertainties = [segment.uncertainty_mm_day for segment in latest]
    overall_change = speeds[-1] - speeds[0]
    overall_margin = _RATE_CHANGE_SIGMAS * math.hypot(uncertainties[0], uncertainties[-1])
    steps = [
        (speeds[index + 1] - speeds[index], math.hypot(uncertainties[index], uncertainties[index + 1]))
        for index in range(len(latest) - 1)
    ]
    if overall_change > overall_margin and all(change > -tolerance for change, tolerance in steps):
        return "逐段增大"
    if -overall_change > overall_margin and all(change < tolerance for change, tolerance in steps) and speeds[0] > 0:
        return "逐段减小"
    return "未见逐段增减"


@dataclass
class HorizontalSeries:
    days: list[float]
    north: list[float]
    east: list[float]


def main_direction(series: HorizontalSeries) -> tuple[float, list[float]] | None:
    """水平主方向（从正北顺时针的方位角）与沿该方向的位移序列。

    主方向取北、东两个分量鲁棒趋势的合成方向；几乎不动时方向不稳定，返回 None，不给出沿方向速率。
    """
    if len(series.days) < 2:
        return None
    north_slope = sampled_slope(series.days, series.north)
    east_slope = sampled_slope(series.days, series.east)
    speed = math.hypot(north_slope, east_slope)
    span = series.days[-1] - series.days[0]
    noise = max(
        point_noise(series.days, series.north, _typical_cadence(series.days)) or 0.0,
        point_noise(series.days, series.east, _typical_cadence(series.days)) or 0.0,
    )
    if speed == 0 or speed * span <= 2 * noise:
        return None
    unit_north = north_slope / speed
    unit_east = east_slope / speed
    azimuth = math.degrees(math.atan2(unit_east, unit_north)) % 360
    projected = [north * unit_north + east * unit_east for north, east in zip(series.north, series.east)]
    return azimuth, projected


def _typical_cadence(days: Sequence[float]) -> float:
    intervals = [later - earlier for earlier, later in zip(days, days[1:]) if later > earlier]
    return median(intervals) if intervals else 1.0
