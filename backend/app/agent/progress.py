"""调查过程每一步的一句发现，由服务端从工具结果确定性生成。

用户等待调查时只看到“已获取位移数据”这类步骤名，看不到任何发现；让模型写进展又不稳定、还多花时间。
这里只复述工具已经算出的事实，不做判断。
"""

import math

_MAX_SUMMARY_CHARS = 80


def _short_time(text: str | None) -> str:
    return text[5:10] if text else ""


def _horizontal_change(features: dict) -> float | None:
    north = (features.get("n") or {}).get("net_change_mm")
    east = (features.get("e") or {}).get("net_change_mm")
    if north is None or east is None:
        return None
    return math.hypot(north, east)


def _window_findings(window: dict) -> list[str]:
    findings = []
    features = window.get("features") or {}
    change = _horizontal_change(features)
    if change is not None:
        findings.append(f"水平变化约 {change:.1f} mm")
    rate = window.get("rate_sequence") or {}
    if rate.get("pattern") in ("逐段增大", "逐段减小"):
        findings.append(f"速率{rate['pattern']}")
    for axis, name in (("n", "北向"), ("e", "东向"), ("u", "垂直")):
        shifts = (features.get(axis) or {}).get("gap_shifts") or []
        if shifts:
            findings.append(f"{_short_time(shifts[0]['gap_from'])} 缺测前后{name}相差约 {shifts[0]['level_shift_mm']:+.1f} mm")
            break
    for axis, name in (("n", "北向"), ("e", "东向"), ("u", "垂直")):
        feature = features.get(axis) or {}
        if feature.get("jump_persistence") == "持续" and feature.get("level_shift_mm") is not None:
            findings.append(f"{name}有约 {feature['level_shift_mm']:+.1f} mm 台阶并保持")
            break
    return findings


def _limited(text: str) -> str:
    return text if len(text) <= _MAX_SUMMARY_CHARS else text[:_MAX_SUMMARY_CHARS - 1] + "…"


def displacement_summary(window: dict) -> str:
    period = f"{_short_time(window['begin_time'])} 至 {_short_time(window['end_time'])}"
    if window.get("points"):
        detail = "，".join(_window_findings(window)) or "已取得数据"
    else:
        detail = "未取得有效观测"
    return _limited(f"{window['station_name']} {period}：{detail}")


def overview_summary(display: dict) -> str:
    parts = []
    for label, window in zip(("近 90 天", "近 7 天"), display["windows"]):
        change = _horizontal_change(window.get("features") or {})
        if change is not None:
            parts.append(f"{label}水平约 {change:.1f} mm")
    recent_rate = (display["windows"][-1].get("rate_sequence") or {}).get("pattern")
    if recent_rate in ("逐段增大", "逐段减小"):
        parts.append(f"近期速率{recent_rate}")
    rainfall = display.get("rainfall") or {}
    if rainfall.get("last_7_days_mm") is not None:
        parts.append(f"近 7 天降雨 {rainfall['last_7_days_mm']:.0f} mm")
    return _limited(f"{display['station_name']}：" + ("，".join(parts) if parts else "已取得概览"))


def weather_summary(data: dict) -> str:
    location = (data.get("location") or {}).get("station_name") or "坐标位置"
    query = data.get("query") or {}
    rain = data.get("rain_summary") or {}
    period = f"{query.get('history_start_date', '')[5:]} 至 {query.get('history_end_date', '')[5:]}"
    parts = []
    if rain.get("history_total_precipitation") is not None:
        parts.append(f"降雨合计 {rain['history_total_precipitation']:.1f} mm")
    maximum = rain.get("history_max_daily_precipitation")
    if maximum:
        parts.append(f"最大日雨量 {maximum['value']:.1f} mm（{maximum['date'][5:]}）")
    return _limited(f"{location} {period}：" + ("，".join(parts) if parts else "未取得降雨数据"))


def site_summary(data: dict) -> str:
    name = (data.get("center_station") or {}).get("station_name", "")
    terrain = data.get("terrain") or {}
    parts = []
    if terrain.get("slope_degrees") is not None:
        parts.append(f"坡度约 {terrain['slope_degrees']:.0f}°")
    if terrain.get("aspect_degrees") is not None:
        parts.append(f"下坡方向约 {terrain['aspect_degrees']:.0f}°")
    return _limited(f"{name}：" + ("，".join(parts) if parts else "未取得地形"))
