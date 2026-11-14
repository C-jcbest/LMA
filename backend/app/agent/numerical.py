"""独立 GNSS 数值计算；描述统计与候选事件分开，不对缺测插值。"""
from collections import Counter
from statistics import median
import math

from app.business_time import TIME_FORMAT
from app.inspection.screening import theil_sen_slope
from app.observations import finite_number, observation_time, station_reference

METRIC_NAMES = {
    'n': '北向相对位移N',
    'e': '东向相对位移E',
    'u': '垂向相对位移U',
    'h': '水平合成偏移模长H',
    'd': '三维合成偏移模长D',
}


def _candidate_events(moments, mm, adjacent):
    steps = [mm[index + 1] - mm[index] for index in sorted(adjacent)]
    center = median(steps)
    noise = 1.4826 * median(abs(step - center) for step in steps)
    # 相对本窗噪声及典型单步变化选择候选；数值精度保护不作为形变阈值。
    threshold = max(6 * noise, 3 * median(abs(step) for step in steps), 1e-6)
    candidates = [index for index in sorted(adjacent) if abs(mm[index + 1] - mm[index]) > threshold]
    events = []
    for index in candidates:
        before_start = index
        while before_start > 0 and before_start - 1 in adjacent and index - before_start < 5:
            before_start -= 1
        after_end = index + 1
        while after_end < len(mm) - 1 and after_end in adjacent:
            if after_end in candidates:
                break
            after_end += 1
        before = mm[before_start:index + 1]
        after = mm[index + 1:after_end + 1]
        previous_level = median(before)
        shift = mm[index + 1] - previous_level
        tolerance = max(3 * noise, .2 * abs(shift), 1e-6)
        held_end = index + 1
        for following in range(index + 2, after_end + 1):
            if abs(mm[following] - mm[index + 1]) > tolerance:
                break
            held_end = following
        status = '待观察'
        if len(before) >= 3 and len(after) >= 3:
            tail = median(after[-3:])
            if abs(tail - previous_level) < abs(shift) / 2:
                status = '回落'
            elif held_end - index >= 3:
                status = '持续'
            elif (tail - mm[index + 1]) * shift > 0:
                status = '继续变化，未稳定'
            else:
                status = '水平变化，需复核'
        # 相邻反向候选可构成孤立尖峰；仍保留两个单步，不把回落当持续台阶。
        recovery = mm[index + 2:index + 5]
        if len(before) >= 3 and len(recovery) >= 3 and all(i in adjacent for i in range(index + 1, index + 4)):
            if all(abs(value - previous_level) <= tolerance for value in recovery):
                status = '回落'
        unknown = []
        for gap in range(index + 1, len(mm) - 1):
            if gap not in adjacent:
                unknown.append({'from': moments[gap].strftime(TIME_FORMAT), 'to': moments[gap + 1].strftime(TIME_FORMAT)})
        events.append({
            'time': moments[index + 1].strftime(TIME_FORMAT),
            'step_mm': mm[index + 1] - mm[index], 'level_shift_mm': shift,
            'noise_mm': noise, 'candidate_threshold_mm': threshold, 'status': status,
            'observed_from': moments[index + 1].strftime(TIME_FORMAT),
            'observed_until': moments[after_end].strftime(TIME_FORMAT),
            'held_until': moments[held_end].strftime(TIME_FORMAT),
            'held_hours': (moments[held_end] - moments[index + 1]).total_seconds() / 3600,
            'followup_count': len(after), 'later_unknown_intervals': unknown[:100],
            'limitation': '仅描述候选附近已观察区间；缺测期间未知，候选不代表灾害或基准变化成因',
        })
    return events


def axis_features(times, values, base=None, cadence_hours=1.0):
    counts = Counter(times)
    valid = []
    for time, value in zip(times, values):
        moment = observation_time(time)
        number = finite_number(value)
        if counts[time] == 1 and moment is not None and number is not None:
            valid.append((moment, number))
    valid.sort()
    base = finite_number(base)
    result = {
        'count': len(valid), 'net_change_mm': None, 'robust_slope_mm_day': None,
        'max_step_mm': None, 'max_step_time': None, 'level_shift_mm': None,
        'jump_persistence': '样本不足', 'cum_start_mm': None, 'cum_end_mm': None,
        'method': 'Theil–Sen；最多300个等索引样本；不插值；重复时间剔除',
        'units': {'displacement': 'mm', 'velocity': 'mm/day'},
        'cadence_hours': cadence_hours, 'effective_span_hours': 0,
        'baseline': '固定初始坐标' if base is not None else '固定参考缺失；仅计算窗口变化',
        'reference_value_m': base, 'trend_supported': False, 'events': [], 'limitations': [],
        'residual_noise_mm': None,
    }
    if any(count > 1 for count in counts.values()):
        result['limitations'].append('重复时间已剔除')
    if not valid:
        result['limitations'].append('没有有效观测')
        return result
    moments, numbers = zip(*valid)
    days = [(moment - moments[0]).total_seconds() / 86400 for moment in moments]
    mm = [(number - numbers[0]) * 1000 for number in numbers]
    result.update(begin_time=moments[0].strftime(TIME_FORMAT), end_time=moments[-1].strftime(TIME_FORMAT),
                  effective_span_hours=days[-1] * 24)
    if base is not None:
        result.update(cum_start_mm=(numbers[0] - base) * 1000, cum_end_mm=(numbers[-1] - base) * 1000)
    if len(valid) < 2:
        result['limitations'].append('有效观测不足两点')
        return result
    sample_count = min(len(mm), 300)
    indices = sorted({round(i * (len(mm) - 1) / (sample_count - 1)) for i in range(sample_count)})
    result.update(net_change_mm=mm[-1],
                  robust_slope_mm_day=theil_sen_slope([days[i] for i in indices], [mm[i] for i in indices]),
                  slope_sample_count=len(indices))
    residuals = [value - result['robust_slope_mm_day'] * day for day, value in zip(days, mm)]
    residual_center = median(residuals)
    result['residual_noise_mm'] = 1.4826 * median(abs(value - residual_center) for value in residuals)
    result['limitations'].append('残差MAD仅描述本窗离散，不代表传感器精度；周期、台阶及基准变化仍需分别核查')
    expected = max(1, round(days[-1] * 24 / cadence_hours) + 1)
    result['trend_supported'] = len(valid) >= 7 and days[-1] * 24 >= cadence_hours * 6 and len(valid) / expected >= .5
    if not result['trend_supported']:
        result['limitations'].append('斜率仅为描述统计，样本或有效跨度不足以支持持续趋势')
    adjacent = {index for index in range(len(days) - 1)
                if 0 < (days[index + 1] - days[index]) * 24 <= cadence_hours * 1.5}
    if len(adjacent) < len(days) - 1:
        result['limitations'].append('存在缺测跨越；跨越差值不计入单步和连续保持区间')
    if not adjacent:
        return result
    index = max(sorted(adjacent), key=lambda i: abs(mm[i + 1] - mm[i]))
    result['max_step_mm'] = abs(mm[index + 1] - mm[index])
    if result['max_step_mm'] > 0:
        result['max_step_time'] = moments[index + 1].strftime(TIME_FORMAT)
    events = _candidate_events(moments, mm, adjacent)
    result['event_count'] = len(events)
    result['events'] = events[:20]
    if len(events) > 20:
        result['limitations'].append('候选超过20个；仅展示前20个，请缩小窗口复核')
    if events:
        primary = max(events, key=lambda event: abs(event['step_mm']))
        result['jump_persistence'] = primary['status']
        result['level_shift_mm'] = primary['level_shift_mm']
    else:
        result['jump_persistence'] = '未见显著突跳候选'
    return result


def horizontal_direction(north_mm, east_mm):
    """水平位移矢量的方位角（从正北顺时针，度）；分量缺失或长度为零时为 None。"""
    if north_mm is None or east_mm is None:
        return None
    magnitude = math.hypot(north_mm, east_mm)
    if magnitude == 0:
        return None
    return {'azimuth_deg': round(math.degrees(math.atan2(east_mm, north_mm)) % 360, 1), 'magnitude_mm': round(magnitude, 3)}


def compare_windows(first, second):
    """保留覆盖和证据条件；倍率本身不构成持续加速结论。"""
    left = first.get('robust_slope_mm_day')
    right = second.get('robust_slope_mm_day')
    return {
        'first': first, 'second': second,
        'velocity_difference_mm_day': None if left is None or right is None else right - left,
        'speed_ratio': None if left in (None, 0) or right is None else abs(right / left),
        'comparison_supported': first.get('trend_supported', False) and second.get('trend_supported', False),
        'limitation': '窗口采样、覆盖、噪声、跨度和方向需同时核查；两窗速度差不证明持续加速',
    }


def common_period_features(stations, axis, cadence_hours=1.0):
    """各方向独立取精确有效时刻交集，不插值或错位匹配。"""
    aligned = {}
    for station, points in stations.items():
        counts = Counter(point.data_time for point in points)
        aligned[station] = {point.data_time: finite_number(getattr(point, axis)) for point in points
                            if counts[point.data_time] == 1 and observation_time(point.data_time) is not None
                            and finite_number(getattr(point, axis)) is not None}
    common = sorted(set.intersection(*(set(values) for values in aligned.values()))) if aligned else []
    result = {}
    for station, values in aligned.items():
        feature = axis_features(common, [values[time] for time in common], cadence_hours=cadence_hours)
        feature['metric_name'] = METRIC_NAMES[axis]
        feature['sample_set'] = {'scope': 'common_period', 'station_uuid': station, 'axis': axis,
                                 'station_uuids': list(stations), 'timestamps': common}
        result[station] = feature
    return result


def window_features(points, station, begin_time, end_time, cadence_hours=1.0, scope='window'):
    """顶层 features 始终为该站全查询窗，分窗和共同样本有独立范围。"""
    reference = station_reference(station)
    times = [point.data_time for point in points]
    features = {}
    for axis in ('n', 'e', 'u', 'h', 'd'):
        if axis in reference:
            values = [getattr(point, axis) for point in points]
            base = reference[axis]
        else:
            components = ('n', 'e') if axis == 'h' else ('n', 'e', 'u')
            values = []
            for point in points:
                if any(reference[key] is None or finite_number(getattr(point, key)) is None for key in components):
                    values.append(None)
                else:
                    values.append(math.sqrt(sum((float(getattr(point, key)) - reference[key]) ** 2 for key in components)))
            base = 0 if all(reference[key] is not None for key in components) else None
        feature = axis_features(times, values, base=base, cadence_hours=cadence_hours)
        feature['metric_name'] = METRIC_NAMES[axis]
        feature['sample_set'] = {'scope': scope, 'station_uuid': station.station_uuid, 'axis': axis,
                                 'requested_begin': begin_time, 'requested_end': end_time,
                                 'timestamps': [time for time, value in zip(times, values) if finite_number(value) is not None]}
        features[axis] = feature
    return features


def numerical_model_data(data):
    """模型看事实范围，完整点集仅保存在快照中；不重复投影每方向的时间戳。"""
    def compact(value):
        if isinstance(value, dict):
            return {key: compact(item) for key, item in value.items()
                    if key not in {"points", "raw_points", "snapshots", "timestamps"}}
        if isinstance(value, list):
            return [compact(item) for item in value]
        return value
    return compact(data)
