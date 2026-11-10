"""GNSS 观测的共同有效性规则及请求采样日历；不猜测或填补观测。"""

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.business_time import TIME_FORMAT

AXES = ("n", "e", "u")


def finite_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def observation_time(value):
    try:
        return datetime.strptime(value, TIME_FORMAT)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Observation:
    data_time: str
    n: float | None
    e: float | None
    u: float | None

    def as_dict(self):
        return {"time": self.data_time, **{axis: getattr(self, axis) for axis in AXES}}


def normalize_observations(points, begin_time=None, end_time=None):
    """整个重复时间戳剔除，避免用输入顺序决定可信值；原始快照由获取方保留。"""
    parsed = [(observation_time(point.data_time), point) for point in points]
    counts = Counter(moment for moment, _ in parsed if moment is not None)
    start = observation_time(begin_time) if begin_time else None
    end = observation_time(end_time) if end_time else None
    normalized = []
    nonfinite = {axis: 0 for axis in AXES}
    outside = 0
    for moment, point in parsed:
        if moment is None:
            continue
        if (start and moment < start) or (end and moment > end):
            outside += 1
            continue
        values = {}
        for axis in AXES:
            raw = getattr(point, axis)
            values[axis] = finite_number(raw)
            if values[axis] is None and raw not in (None, ""):
                nonfinite[axis] += 1
        if counts[moment] == 1:
            normalized.append(Observation(moment.strftime(TIME_FORMAT), **values))
    normalized.sort(key=lambda point: point.data_time)
    return normalized, {
        "received": len(points),
        "invalid_time": sum(moment is None for moment, _ in parsed),
        "duplicate_records": sum(count - 1 for count in counts.values()),
        "duplicate_timestamps": sum(count > 1 for count in counts.values()),
        "invalid_values": nonfinite,
        "outside_window": outside,
    }


def sampling_calendar(begin_time, end_time, *, frequency_minutes=60, sample_times=None):
    """闭区间，固定每日时刻或从当日零时对齐的采样间隔。"""
    start = datetime.strptime(begin_time, TIME_FORMAT)
    end = datetime.strptime(end_time, TIME_FORMAT)
    if start > end or frequency_minutes <= 0:
        raise ValueError("采样日历必须为正向窗口和正间隔")
    midnight = start.replace(hour=0, minute=0, second=0, microsecond=0)
    moments = []
    if sample_times:
        day = midnight
        offsets = [datetime.strptime(value[:5], "%H:%M") for value in sample_times]
        while day <= end:
            for offset in offsets:
                moment = day.replace(hour=offset.hour, minute=offset.minute)
                if start <= moment <= end:
                    moments.append(moment)
            day += timedelta(days=1)
    else:
        step = timedelta(minutes=frequency_minutes)
        moment = midnight + math.ceil((start - midnight) / step) * step
        while moment <= end:
            moments.append(moment)
            moment += step
    return sorted(set(moment.strftime(TIME_FORMAT) for moment in moments))


def observation_quality(points, begin_time, end_time, *, frequency_minutes=60, sample_times=None, cleaning=None):
    expected = sampling_calendar(begin_time, end_time, frequency_minutes=frequency_minutes, sample_times=sample_times)
    expected_set = set(expected)
    by_time = {point.data_time: point for point in points}
    axes = {}
    for axis in AXES:
        valid = [time for time in expected if time in by_time and getattr(by_time[time], axis) is not None]
        axes[axis] = {
            "valid": len(valid), "missing": len(expected) - len(valid),
            "first_valid_time": valid[0] if valid else None,
            "latest_valid_time": valid[-1] if valid else None,
        }
    missing = [time for time in expected if time not in by_time or all(getattr(by_time[time], axis) is None for axis in AXES)]
    missing_set = set(missing)
    gaps = []
    index = 0
    while index < len(expected):
        if expected[index] not in missing_set:
            index += 1
            continue
        first = index
        while index + 1 < len(expected) and expected[index + 1] in missing_set:
            index += 1
        last = index
        boundary = "interior"
        if first == 0 and last == len(expected) - 1:
            boundary = "all"
        elif first == 0:
            boundary = "leading"
        elif last == len(expected) - 1:
            boundary = "trailing"
        gaps.append({
            "from": expected[first - 1] if first > 0 else begin_time,
            "to": expected[last + 1] if last + 1 < len(expected) else end_time,
            "missing_hours": (last - first + 1) * (frequency_minutes / 60 if not sample_times else 24 / len(sample_times)),
            "missing_count": last - first + 1, "boundary": boundary,
            "first_missing_time": expected[first], "last_missing_time": expected[last],
        })
        index += 1
    return {
        "requested_begin": begin_time, "requested_end": end_time,
        "calendar": {"frequency_minutes": None if sample_times else frequency_minutes, "sample_times": sample_times},
        "expected": len(expected), "axes": axes, "missing": len(missing),
        "off_calendar": sum(time not in expected_set for time in by_time),
        "gaps": gaps[:100], "gap_count": len(gaps), "gaps_truncated": len(gaps) > 100,
        "cleaning": cleaning or {},
        "basis": "请求采样日历；质量在展示抽稀前计算，抽稀不计作平台缺测",
    }


def station_reference(station):
    return {axis: finite_number(getattr(station, f"station_{axis}0", None)) for axis in AXES}


def raw_snapshot(points):
    return [
        {"time": point.data_time, **{axis: str(getattr(point, axis)) if getattr(point, axis) is not None else None for axis in AXES}}
        for point in points
    ]
