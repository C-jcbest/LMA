"""独立 GNSS 数值计算；不依赖图像或模型，不对缺测插值。"""
import math
from collections import Counter
from datetime import datetime
from statistics import median

from app.business_time import TIME_FORMAT
from app.inspection.screening import theil_sen_slope


def axis_features(times, values, base=None, cadence_hours=1.0):
    counts = Counter(times)
    valid = []
    for time, value in zip(times, values):
        if counts[time] != 1:
            continue
        try:
            number = float(value)
            moment = datetime.strptime(time, TIME_FORMAT)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            valid.append((moment, number))
    valid.sort()
    result = {
        "count": len(valid), "net_change_mm": None, "robust_slope_mm_day": None,
        "max_step_mm": None, "max_step_time": None, "level_shift_mm": None,
        "jump_persistence": "样本不足", "cum_start_mm": None, "cum_end_mm": None,
        "method": "Theil–Sen；最多300个等索引样本；不插值；重复时间剔除",
        "units": {"displacement": "mm", "velocity": "mm/day"},
        "cadence_hours": cadence_hours,
        "baseline": "固定初始坐标" if base is not None else "窗口首个有效点（不是固定初始坐标累计偏移）",
        "limitations": [],
    }
    if any(count > 1 for count in counts.values()):
        result["limitations"].append("重复时间已剔除")
    if len(valid) < 2:
        result["limitations"].append("有效观测不足两点")
        return result
    moments, numbers = zip(*valid)
    days = [(moment - moments[0]).total_seconds() / 86400 for moment in moments]
    origin = numbers[0] if base is None else base
    mm = [(number - origin) * 1000 for number in numbers]
    sample_count = min(len(mm), 300)
    indices = sorted({round(i * (len(mm) - 1) / (sample_count - 1)) for i in range(sample_count)})
    result.update(
        begin_time=moments[0].strftime(TIME_FORMAT), end_time=moments[-1].strftime(TIME_FORMAT),
        cum_start_mm=mm[0], cum_end_mm=mm[-1], net_change_mm=mm[-1] - mm[0],
        robust_slope_mm_day=theil_sen_slope([days[i] for i in indices], [mm[i] for i in indices]),
        slope_sample_count=len(indices),
    )
    adjacent = {
        index for index in range(len(days) - 1)
        if 0 < (days[index + 1] - days[index]) * 24 <= cadence_hours * 1.5
    }
    if len(adjacent) < len(days) - 1:
        result["limitations"].append("存在缺测跨越；跨越差值不计入单步和持续性")
    if not adjacent:
        return result
    index = max(sorted(adjacent), key=lambda i: abs(mm[i + 1] - mm[i]))
    result["max_step_mm"] = abs(mm[index + 1] - mm[index])
    if result["max_step_mm"] == 0:
        result["jump_persistence"] = "未见单步变化"
        return result
    result["max_step_time"] = moments[index + 1].strftime(TIME_FORMAT)
    result["jump_persistence"] = "待观察"
    before = mm[max(0, index - 5):index + 1]
    after = mm[index + 1:index + 7]
    result["level_shift_mm"] = median(after) - median(before)
    tail = mm[index + 7:]
    continuous = all(i in adjacent for i in range(max(0, index - 5), len(mm) - 1))
    if len(tail) >= 3 and continuous:
        tolerance = max(2.0, 0.2 * abs(result["level_shift_mm"]))
        tail_change = median(tail) - median(after)
        if abs(result["level_shift_mm"]) <= result["max_step_mm"] / 2:
            result["jump_persistence"] = "回落"
        elif abs(tail_change) <= tolerance:
            result["jump_persistence"] = "持续"
        elif tail_change * result["level_shift_mm"] < 0:
            result["jump_persistence"] = "回落"
        else:
            result["jump_persistence"] = "继续变化，未稳定"
    else:
        result["limitations"].append("跳变后连续观测不足，尚不能确认保持")
    return result


def compare_windows(first, second):
    """保留两个窗口的覆盖信息；零速率不产生无穷倍率。"""
    left = first.get("robust_slope_mm_day")
    right = second.get("robust_slope_mm_day")
    return {
        "first": first, "second": second,
        "velocity_difference_mm_day": None if left is None or right is None else right-left,
        "speed_ratio": None if left in (None, 0) or right is None else abs(right/left),
        "limitation": "窗口采样、覆盖和方向需同时核查；倍率本身不构成加速结论",
    }


def common_period_features(stations, axis, cadence_hours=1.0):
    """仅使用所有测点共同有效的精确时间戳，不插值或错位匹配。"""
    aligned = {}
    for station, points in stations.items():
        counts = Counter(point.data_time for point in points)
        values = {}
        for point in points:
            try:
                value = float(getattr(point, axis))
            except (ValueError, TypeError):
                continue
            if counts[point.data_time] == 1 and math.isfinite(value):
                values[point.data_time] = value
        aligned[station] = values
    common = sorted(set.intersection(*(set(values) for values in aligned.values()))) if aligned else []
    return {station: axis_features(common, [values[t] for t in common], cadence_hours=cadence_hours)
            for station, values in aligned.items()}
