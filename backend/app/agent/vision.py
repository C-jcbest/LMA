"""GNSS 时序图表的视觉复核工具，供智能体调用。

仿照 landslide-monitoring-agent 的 ChartVisionService 裁剪为本项目极简实现：
单一工具、单一提示词；每次工具尝试只有一次视觉调用。
流程：拉取该时间范围的全量 GNSS 数据 → matplotlib 渲染多张分析图
（原始时序/累计位移/合成位移）→ 视觉模型输出事实观察 + 形态学推断（interpretation，
非确定措辞）→ Pydantic 结构化校验（时间窗/方向白名单）→ 对每个异常候选区间经
网络回查原始小时级数据计算五类数值特征（相对初始点累计位移、窗口净变化、
鲁棒斜率、最大单步变化、跳后持续性），并给出全范围 global_features。

子窗口放大不靠工具内部多阶段，而是由主智能体用更窄的 begin_time/end_time
重复调用本工具实现：窗口越窄图表横向分辨率越高；累计位移基线为站点初始坐标
（未登记回退首点），跨时间范围连续可比。

图片通过 LangChain artifact 机制返回（response_format="content_and_artifact"）：
挂在 ToolMessage.artifact 上随流转发给前端，但不进入 LLM 上下文；
LLM 只读 JSON 观察结果。chart_points（全量序列）同样放在 artifact 中
供前端 SVG 兑底渲染，避免全量数据挤占 LLM 上下文。
"""

import asyncio
import base64
import json
import math
import logging
import re
import statistics
from datetime import datetime, timedelta
from functools import lru_cache
from io import BytesIO

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from app.agent.tool_inputs import VisionInput
from app.agent.tool_protocol import ToolFailure, tool_error_result, tool_result
from pydantic import BaseModel, Field, ValidationError

from app.agent.prompting import VISION_PROMPT
from app.agent.retry import is_transient_error
from app.business_time import BUSINESS_TIMEZONE
from app.agent.tools import (
    _TIME_FORMAT,
    _build_client,
    _resolve_station,
    _to_float,
)
from app.beidou.client import BeidouClient
from app.config import get_settings
from app.agent.models import create_chat_model

# 渲染使用全量数据，不做降采样（降采样会漏掉采样点之间的异常形态）
_MIN_POINTS = 5  # 少于该点数不值得绘图识别
_RECHECK_CONCURRENCY = 5  # 异常区间回查的并发上限

# 图表定义：name 与前端标题约定
_CHART_RAW = "raw_coordinates"
_CHART_CUMULATIVE = "cumulative_displacement"
_CHART_RESULTANT = "resultant_displacement"


class VisualReading(BaseModel):
    metric: str
    time: str = ""
    value: str = ""
    note: str = ""


class VisualCandidate(BaseModel):
    metric: str
    start_at: str
    end_at: str
    description: str = Field(default="", max_length=240)


class VisionObservations(BaseModel):
    """视觉模型输出（服务端校验后）。

    列表字段不加 max_length 约束：超量时由 _validate_observations 截断，
    避免模型多报一条导致整个响应被拒。candidates 不静默截断；有效候选超过服务端预算时明确拒绝数值回查。interpretation 为形态学推断（非事实观察），
    由提示词约束其使用非确定措辞。
    """

    model_config = {"extra": "ignore"}

    trends: list[str] = Field(default_factory=list)
    turning_points: list[str] = Field(default_factory=list)
    readings: list[VisualReading] = Field(default_factory=list)
    candidates: list[VisualCandidate] = Field(default_factory=list)
    interpretation: list[str] = Field(default_factory=list)
    image_quality: str = ""
    fact_text: str = ""
    limitations: list[str] = Field(default_factory=list)


@lru_cache
def _get_vision_llm():
    settings = get_settings()
    # 独立思考开关：Provider 层显式映射为供应商官方参数；默认关闭以控制延迟和 token。
    return create_chat_model(
        provider=settings.vision_provider,
        model=settings.vision_model,
        api_key=settings.vision_api_key,
        base_url=settings.vision_base_url,
        thinking=settings.vision_thinking,
        protocol="chat_completions",
        temperature=0,
        # 预算必须宽裕：思考开启时视觉模型每次输出中约 2000 token 是
        # 内部思考（reasoning），正文 JSON 另需 ~1000+；预算不足时正文被
        # 截断导致 JSON 解析间歇性失败
        max_completion_tokens=8000,
        timeout=120,
    )



def _downsample(points: list, limit: int) -> list:
    """等间隔降采样（保留首末点）。现仅调试脚本使用；
    生产渲染与 chart_points 均已改为全量数据。"""
    if len(points) <= limit:
        return list(points)
    step = math.ceil(len(points) / limit)
    sampled = points[::step]
    if sampled[-1] is not points[-1]:
        sampled.append(points[-1])
    return sampled


def _render_chart_png(
    points: list,
    baseline: tuple[float, float, float] | None,  # 与其他渲染器签名一致；原始时序不用基线
    station_name: str,
    begin_time: str,
    end_time: str,
) -> bytes:
    """渲染原始坐标 N/E/U 三联时序图（Agg 后端，内存内出图）。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = [datetime.strptime(p.data_time, _TIME_FORMAT) for p in points]
    fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    # 标题用 ASCII，避免无中文字体环境下乱码
    fig.suptitle(f"GNSS Displacement - {station_name}", fontsize=13)

    for axis, key, label in zip(axes, ("n", "e", "u"), ("N (m)", "E (m)", "U (m)")):
        values = [_to_float(getattr(p, key)) for p in points]
        axis.plot(times, values, linewidth=1.1, color="#2563eb")
        axis.set_ylabel(label, fontsize=10)
        axis.grid(True, alpha=0.3)

    axes[-1].set_xlabel(f"{begin_time} ~ {end_time} (Asia/Shanghai)", fontsize=9)
    fig.autofmt_xdate()
    fig.tight_layout(rect=(0, 0, 1, 0.97))

    buffer = BytesIO()
    fig.savefig(buffer, format="png", dpi=100)
    plt.close(fig)
    return buffer.getvalue()


def _series_values(points: list, key: str) -> list[float | None]:
    return [_to_float(getattr(p, key)) for p in points]


def _shade_gaps(axis, times: list[datetime]) -> None:
    """在图上用橙色阴影标注缺测时段（间隔≥中位间隔 3 倍），辅助异常定位。"""
    if len(times) < 3:
        return
    intervals = [(times[i + 1] - times[i]).total_seconds() for i in range(len(times) - 1)]
    median = sorted(intervals)[len(intervals) // 2]
    if median <= 0:
        return
    for i, sec in enumerate(intervals):
        if sec >= median * 3:
            axis.axvspan(times[i], times[i + 1], color="#f59e0b", alpha=0.18, linewidth=0)


def _save_fig_png(fig) -> bytes:
    buffer = BytesIO()
    fig.savefig(buffer, format="png", dpi=100)
    return buffer.getvalue()


def _resolve_baseline(station) -> tuple[float, float, float] | None:
    """累计位移基线：监测点初始坐标（StationN0/E0/U0）三值齐全才启用；
    任一缺失或非法时返回 None，渲染回退为数据首点基线。"""
    n0 = _to_float(getattr(station, "station_n0", None))
    e0 = _to_float(getattr(station, "station_e0", None))
    u0 = _to_float(getattr(station, "station_u0", None))
    if n0 is None or e0 is None or u0 is None:
        return None
    return (n0, e0, u0)


def _render_cumulative_png(
    points: list,
    baseline: tuple[float, float, float] | None,
    station_name: str,
    begin_time: str,
    end_time: str,
) -> bytes:
    """渲染累计位移图：相对基线的 ΔN/ΔE/ΔU（mm），叠加缺测阴影。
    基线优先用监测点初始坐标（StationN0/E0/U0），未登记时回退为数据首点；
    累计位移能直观暴露跳变与持续形变，是形态异常识别的主要视图。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = [datetime.strptime(p.data_time, _TIME_FORMAT) for p in points]
    fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    base_desc = "from initial coords" if baseline else "from first sample"
    fig.suptitle(f"Cumulative Displacement ({base_desc}, mm) - {station_name}", fontsize=13)

    for axis, key, label in zip(axes, ("n", "e", "u"), ("dN (mm)", "dE (mm)", "dU (mm)")):
        values = _series_values(points, key)
        base = None
        if baseline is not None:
            base = {"n": baseline[0], "e": baseline[1], "u": baseline[2]}[key]
        if base is None:
            base = next((v for v in values if v is not None), None)
        if base is None:
            continue
        deltas = [None if v is None else (v - base) * 1000.0 for v in values]
        axis.plot(times, deltas, linewidth=1.1, color="#16a34a", marker="", markersize=0)
        axis.axhline(0, color="#9ca3af", linewidth=0.8, linestyle="--")
        _shade_gaps(axis, times)
        axis.set_ylabel(label, fontsize=10)
        axis.grid(True, alpha=0.3)

    axes[-1].set_xlabel(f"{begin_time} ~ {end_time} (Asia/Shanghai)   (orange shading = data gaps)", fontsize=9)
    fig.autofmt_xdate()
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    return _save_fig_png(fig)


def _render_resultant_png(
    points: list,
    baseline: tuple[float, float, float] | None,
    station_name: str,
    begin_time: str,
    end_time: str,
) -> bytes:
    """渲染合成位移图：水平位移 sqrt(dN²+dE²) 与三维位移 sqrt(dN²+dE²+dU²)（mm）。
    基线与累计位移图一致（初始坐标优先，回退首点）。"""
    import math as _math

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = [datetime.strptime(p.data_time, _TIME_FORMAT) for p in points]
    ns, es, us = (_series_values(points, k) for k in ("n", "e", "u"))

    def _base(values: list) -> float | None:
        return next((v for v in values if v is not None), None)

    if baseline is not None:
        bn, be, bu = baseline
    else:
        bn, be, bu = _base(ns), _base(es), _base(us)
    horizontal, spatial = [], []
    for n, e, u in zip(ns, es, us):
        if bn is None or be is None or bu is None or None in (n, e, u):
            horizontal.append(None)
            spatial.append(None)
            continue
        dn, de, du = (n - bn) * 1000.0, (e - be) * 1000.0, (u - bu) * 1000.0
        horizontal.append(_math.sqrt(dn * dn + de * de))
        spatial.append(_math.sqrt(dn * dn + de * de + du * du))

    fig, axis = plt.subplots(figsize=(12, 5))
    base_desc = "from initial coords" if baseline else "from first sample"
    fig.suptitle(f"Resultant Displacement ({base_desc}, mm) - {station_name}", fontsize=13)
    axis.plot(times, horizontal, linewidth=1.2, color="#2563eb", label="Horizontal = sqrt(dN^2+dE^2)")
    axis.plot(times, spatial, linewidth=1.2, color="#dc2626", label="3D = sqrt(dN^2+dE^2+dU^2)", alpha=0.85)
    _shade_gaps(axis, times)
    axis.set_ylabel("displacement (mm)", fontsize=10)
    axis.set_xlabel(f"{begin_time} ~ {end_time} (Asia/Shanghai)   (orange shading = data gaps)", fontsize=9)
    axis.legend(fontsize=9, loc="best")
    axis.grid(True, alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    return _save_fig_png(fig)


# 前端图表中文标题（随 artifact 的 title 字段下发，前端优先使用；name 映射为兑底）
_CHART_TITLES_INITIAL = {
    _CHART_RAW: "原始坐标时序（N/E/U）",
    _CHART_CUMULATIVE: "累计位移（相对初始坐标，mm）",
    _CHART_RESULTANT: "合成位移（水平/三维，mm）",
}
_CHART_TITLES_FIRST = {
    _CHART_RAW: "原始坐标时序（N/E/U）",
    _CHART_CUMULATIVE: "累计位移（相对首点，mm）",
    _CHART_RESULTANT: "合成位移（水平/三维，mm）",
}


def _render_all_charts(
    points: list,
    baseline: tuple[float, float, float] | None,
    station_name: str,
    begin_time: str,
    end_time: str,
) -> list[dict]:
    """渲染全部分析图，返回 [{name, title, png_base64}]。"""
    renderers = [
        (_CHART_RAW, _render_chart_png),
        (_CHART_CUMULATIVE, _render_cumulative_png),
        (_CHART_RESULTANT, _render_resultant_png),
    ]
    titles = _CHART_TITLES_INITIAL if baseline is not None else _CHART_TITLES_FIRST
    charts = []
    for name, render in renderers:
        try:
            png = render(points, baseline, station_name, begin_time, end_time)
            charts.append(
                {"name": name, "title": titles[name], "png_base64": base64.b64encode(png).decode("ascii")}
            )
        except Exception:
            logging.getLogger(__name__).warning("chart rendering failed", exc_info=True)
            # 单张渲染失败不影响其他图
            continue
    return charts


def _parse_time(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, _TIME_FORMAT)
    except (TypeError, ValueError):
        return None


def _validate_observations(
    data: VisionObservations | dict, time_start: datetime, time_end: datetime
) -> VisionObservations:
    """校验视觉模型结构化输出，越界（时间窗外/非法方向）的条目直接剔除。"""
    observations = (
        data if isinstance(data, VisionObservations) else VisionObservations.model_validate(data)
    )
    valid: VisionObservations = VisionObservations(
        trends=observations.trends[:4],
        turning_points=observations.turning_points[:4],
        readings=[r for r in observations.readings if r.metric in ("N", "E", "U")][:4],
        candidates=[],
        interpretation=[s[:300] for s in observations.interpretation if s.strip()][:4],
        image_quality=observations.image_quality[:240],
        fact_text=observations.fact_text[:800],
        limitations=observations.limitations[:4],
    )
    # 此处做方向与时间窗校验，不静默截断；主工具在回查前校验有效候选预算。
    for candidate in observations.candidates:
        if candidate.metric not in ("N", "E", "U"):
            continue
        start = _parse_time(candidate.start_at)
        end = _parse_time(candidate.end_at)
        # 时间必须落在图表范围内且 start <= end，否则视为幻觉剔除
        if (
            start is None
            or end is None
            or start > end
            or not (time_start <= start <= time_end)
            or not (time_start <= end <= time_end)
        ):
            continue
        valid.candidates.append(candidate)
    return valid



def _is_empty_observation(obs: VisionObservations) -> bool:
    """判断视觉模型是否实际看到了图：四类观察全部为空，
    通常意味着模型声称“未接收到图像”或完全未处理图片。"""
    return not (
        obs.trends or obs.turning_points or obs.readings or obs.candidates
    )


def _axis_detail(pairs: list[tuple[str, float | None]]) -> dict:
    """带极值时刻的单方向数值摘要：首末值、变化量、极值及极值出现时刻。
    极值时刻用于发现落在定位区间边缘之外的异常点（视觉定位时间略偏时）。"""
    valid = [(t, v) for t, v in pairs if v is not None]
    if not valid:
        return {"count": 0}
    nums = [v for _, v in valid]
    vmax, vmin = max(nums), min(nums)
    return {
        "count": len(valid),
        "first": nums[0],
        "last": nums[-1],
        "change": round(nums[-1] - nums[0], 4),
        "min": vmin,
        "max": vmax,
        "min_time": next(t for t, v in valid if v == vmin),
        "max_time": next(t for t, v in valid if v == vmax),
    }


# 跳后持续性判定容差：水平差超过 max(绝对容差mm, 比例×跳变幅度) 视为"回落"
_PERSIST_ABS_TOL_MM = 2.0
_PERSIST_REL_TOL = 0.2
# 鲁棒斜率计算的抽样上限：Theil–Sen 两两斜率为 O(n²)，等间隔抽样控制计算量
_SLOPE_SAMPLE_LIMIT = 300


def _axis_features(
    times: list[str], values: list[float | None], base: float | None
) -> dict:
    """单方向子窗口数值特征（位移单位 mm，相对基线 base；base 为 None 时相对窗口首点）。

    - 累计位移 cum_start_mm/cum_end_mm：窗口首/末有效点相对基线的累计位移；
    - 窗口净变化 net_change_mm：首有效点 → 末有效点之差；
    - 鲁棒斜率 robust_slope_mm_day：Theil–Sen 估计（等间隔抽样后取两两斜率中位数），
      对台阶/毛刺稳健，是识别持续形变的主要数值依据；
    - 最大单步变化 max_step_mm 及其时刻（仅统计相邻采样点之间的单步）；
    - 跳后持续性：以最大单步为跳变点，跳变前后各至多 6 点中位数之差为 level_shift_mm，
      跳变后剩余点整体中位数偏离紧邻跳变后水平超过容差判为"回落"，否则"持续"。
    """
    idx = [i for i, v in enumerate(values) if v is not None]
    if len(idx) < 2:
        return {"count": len(idx)}
    vals = [values[i] for i in idx]
    valid_times = [times[i] for i in idx]
    if base is None:
        base = vals[0]
    mm = [(v - base) * 1000.0 for v in vals]

    # 鲁棒斜率（Theil–Sen）：等间隔抽样 ≤300 点后计算两两斜率的中位数
    step = max(1, math.ceil(len(mm) / _SLOPE_SAMPLE_LIMIT))
    sub = list(range(0, len(mm), step))
    if sub[-1] != len(mm) - 1:
        sub.append(len(mm) - 1)
    times_sec = []
    for t in valid_times:
        parsed = _parse_time(t)
        times_sec.append(parsed.timestamp() if parsed else 0.0)
    pair_slopes = []
    for a in range(len(sub)):
        for b in range(a + 1, len(sub)):
            dt_days = (times_sec[sub[b]] - times_sec[sub[a]]) / 86400
            if dt_days > 0:
                pair_slopes.append((mm[sub[b]] - mm[sub[a]]) / dt_days)
    robust_slope = (
        sorted(pair_slopes)[len(pair_slopes) // 2] if pair_slopes else None
    )

    # 最大单步变化（相邻采样点之间）与跳后持续性
    max_step, max_step_idx, max_step_time = 0.0, -1, ""
    for k in range(len(idx) - 1):
        if idx[k + 1] == idx[k] + 1:  # 仅统计真正相邻的采样点，跨缺测的差值不可信
            step_value = abs(vals[k + 1] - vals[k]) * 1000.0
            if step_value > max_step:
                max_step, max_step_idx = step_value, k
                max_step_time = valid_times[k + 1]

    level_shift: float | None = None
    persistence = "样本不足"
    if max_step_idx >= 0:
        j = max_step_idx  # 跳变发生在 vals[j] -> vals[j+1]
        pre_n = min(6, j + 1)
        post_n = min(6, len(vals) - (j + 1))
        if pre_n >= 1 and post_n >= 1:
            pre = statistics.median(vals[j + 1 - pre_n : j + 1])
            post = statistics.median(vals[j + 1 : j + 1 + post_n])
            level_shift = (post - pre) * 1000.0
            tail = vals[j + 1 + post_n :]
            if len(tail) >= 3:
                tolerance = max(_PERSIST_ABS_TOL_MM, _PERSIST_REL_TOL * abs(level_shift))
                persistence = (
                    "持续"
                    if abs((statistics.median(tail) - post) * 1000.0) <= tolerance
                    else "回落"
                )

    return {
        "count": len(vals),
        "cum_start_mm": round(mm[0], 3),
        "cum_end_mm": round(mm[-1], 3),
        "net_change_mm": round(mm[-1] - mm[0], 3),
        "robust_slope_mm_day": round(robust_slope, 4) if robust_slope is not None else None,
        "max_step_mm": round(max_step, 3),
        "max_step_time": max_step_time,
        "level_shift_mm": round(level_shift, 3) if level_shift is not None else None,
        "jump_persistence": persistence,
    }


def _window_features(
    points: list, baseline: tuple[float, float, float] | None
) -> dict:
    """对一段数据点计算三方向形态数值特征（单位 mm）。

    基线优先用监测点初始坐标（StationN0/E0/U0），未登记时各方向回退为窗口首点。
    """
    if not points:
        return {"points": 0}
    times = [p.data_time for p in points]
    features: dict = {
        "points": len(points),
        "begin_time": times[0],
        "end_time": times[-1],
        "baseline": "监测点初始坐标" if baseline is not None else "窗口首点",
    }
    for key, base_index in (("n", 0), ("e", 1), ("u", 2)):
        base = baseline[base_index] if baseline is not None else None
        features[key] = _axis_features(times, [_to_float(getattr(p, key)) for p in points], base)
    return features


async def _recheck_candidate_window(
    client: BeidouClient,
    station_uuid: str,
    candidate: VisualCandidate,
    baseline: tuple[float, float, float] | None,
    pad_hours: int,
    time_start: datetime,
    time_end: datetime,
) -> dict:
    """按视觉定位的异常区间经网络回查原始 GNSS 数据，取区间内的准确数值与形态特征。

    首次全量拉取可能被降采样，回查该窗口拿到的是小时级全分辨率数据。
    视觉估读时间存在误差，窗口过小会截掉边界关键点：起止时间先向两侧各
    外扩 pad_hours 小时（并夹取到整个查询范围内）再查。返回各方向数值摘要
    （单位 m）与五类形态数值特征（单位 mm，见 _window_features），
    供 LLM 判断候选是否被数值证据支持。
    """
    start = _parse_time(candidate.start_at)
    end = _parse_time(candidate.end_at)
    if start is None or end is None:
        return {"ok": False, "error": "回查失败：候选区间时间无法解析"}
    pad = timedelta(hours=max(0, pad_hours))
    query_start = max(start - pad, time_start)
    query_end = min(end + pad, time_end)
    try:
        points = await client.get_daily_data(
            station_uuid=station_uuid,
            begin_time=query_start.strftime(_TIME_FORMAT),
            end_time=query_end.strftime(_TIME_FORMAT),
        )
    except Exception as e:
        logging.getLogger(__name__).warning("numerical recheck failed", exc_info=True)
        if is_transient_error(e):
            raise
        return {"ok": False, "error": "数值回查失败，候选尚未获得数值复核支持"}
    return {
        "ok": True,
        "begin_time": query_start.strftime(_TIME_FORMAT),
        "end_time": query_end.strftime(_TIME_FORMAT),
        "pad_hours": max(0, pad_hours),
        "points": len(points),
        "summary": {
            "n": _axis_detail([(p.data_time, _to_float(p.n)) for p in points]),
            "e": _axis_detail([(p.data_time, _to_float(p.e)) for p in points]),
            "u": _axis_detail([(p.data_time, _to_float(p.u)) for p in points]),
        },
        "features": _window_features(points, baseline),
    }


async def _recheck_candidates(
    client: BeidouClient,
    station_uuid: str,
    candidates: list[VisualCandidate],
    baseline: tuple[float, float, float] | None,
    pad_hours: int,
    time_start: datetime,
    time_end: datetime,
) -> list[dict]:
    """并发回查全部异常候选区间（不设数量上限，用信号量限流）。

    单方向候选也返回三方向摘要与特征，便于对照判断（如 N 跳变伴随 E 同步跳变
    更可能是整站坐标基准问题而非单轴形变）。
    """
    semaphore = asyncio.Semaphore(_RECHECK_CONCURRENCY)

    async def _bounded(candidate: VisualCandidate) -> dict:
        async with semaphore:
            return await _recheck_candidate_window(
                client, station_uuid, candidate, baseline, pad_hours, time_start, time_end
            )

    return list(await asyncio.gather(*(_bounded(c) for c in candidates)))


@tool(response_format="content_and_artifact", args_schema=VisionInput)
async def analyze_gnss_chart(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    tool_call_id: str,
) -> tuple[str | ToolMessage, dict]:
    """渲染指定监测点在时间范围内的 GNSS 原始坐标、累计位移与合成位移图，
    并由视觉模型返回全窗口形态观察及候选区间。累计位移优先以监测点初始坐标为基准，
    未登记时回退到窗口首个有效点。

    Args:
        station_name_or_uuid: 监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID。
        begin_time: 开始时间，业务时区 Asia/Shanghai，格式必须为 "YYYY-MM-DD HH:mm:ss"。
        end_time: 结束时间，格式必须为 "YYYY-MM-DD HH:mm:ss"，可跨天。

    返回视觉观察（趋势、拐点、候选区间、数值特征、形态学解释和近似读数）；
    渲染好的图表 PNG（images，全量数据绘制）与全量 chart_points 数据序列
    通过 artifact 随流转发给前端展示，不进入模型上下文。
    """
    time_start = datetime.strptime(begin_time, _TIME_FORMAT)
    time_end = datetime.strptime(end_time, _TIME_FORMAT)

    async with _build_client() as client:
        station = await _resolve_station(client, station_name_or_uuid)
        if station.station_type == 1:
            raise ToolFailure("该监测点为基准站，仅提供差分基准，不适用普通移动站形变序列分析；这不表示监测异常。")

        points = await client.get_daily_data(
            station_uuid=station.station_uuid,
            begin_time=begin_time,
            end_time=end_time,
        )

        if len(points) < _MIN_POINTS:
            raise ToolFailure(f"该时段数据点过少（{len(points)} 条），不足以绘图复核")

        # 前端展示用全量数据序列：放在 artifact 中随流转发给前端（不进入
        # LLM 上下文，避免全量数据挤占上下文；数值证据由 recheck 按区间精查提供）
        chart_points = [
            {
                "t": p.data_time,
                "n": _to_float(p.n),
                "e": _to_float(p.e),
                "u": _to_float(p.u),
            }
            for p in points
        ]

        settings = get_settings()
        baseline = _resolve_baseline(station)
        # 基线口径说明（用于视觉输入与重试文案）：
        # 初始坐标基准（平台登记 StationN0/E0/U0）或回退的首点基准
        baseline_desc = (
            "相对监测点初始坐标" if baseline is not None else "相对数据首点（站点未登记初始坐标）"
        )
        base_result = {
            "station_name": station.station_name,
            "begin_time": begin_time,
            "end_time": end_time,
            "timezone": BUSINESS_TIMEZONE,
            "total_points": len(points),
        }

        # 图片始终渲染（前端展示用），视觉模型未配置时仅跳过识别。
        # 渲染必须放入工作线程：matplotlib 首次 import 会同步探测配置目录
        # （os.getcwd/os.path.realpath），在 langgraph dev 的 blockbuster 检测下
        # 直接抛 BlockingError，导致 Server 环境图表全部渲染失败
        charts = await asyncio.to_thread(
            _render_all_charts, points, baseline, station.station_name, begin_time, end_time
        )
        # chart_points 始终随 artifact 返回：渲染失败时前端仍可用全量序列兑底绘制
        artifact = {"images": charts, "chart_points": chart_points, "data": base_result}
        if not charts:
            return tool_error_result(
                "图表渲染失败，无法进行视觉复核",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                artifact=artifact,
            )

        if not (settings.vision_base_url and settings.vision_api_key and settings.vision_model):
            return tool_error_result(
                "视觉模型未配置，无法进行图表形态复核；已返回图表供人工查看。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                category="configuration",
                artifact={**artifact, "data": base_result},
            )

        # 单次视觉调用（单一提示词）：送累计位移与合成位移两张图做全窗口观察。
        # 需要精确判读某子窗口时，由主智能体以更窄时间范围重复调用本工具实现"放大"。
        # 原始时序与累计位移形态等价（仅差基准），两图大载荷下视觉模型间歇性
        # 返回非 JSON，不再多送。artifact 仍包含全部 3 图供前端展示
        vision_charts = [c for c in charts if c["name"] in (_CHART_CUMULATIVE, _CHART_RESULTANT)] or charts
        chart_desc = (
            f"第 1 张图为{baseline_desc}的累计位移 ΔN/ΔE/ΔU（mm，橙色阴影为缺测时段），"
            "第 2 张为合成位移（水平与三维，mm，同一基线）。"
            "累计位移与合成位移图最宜识别跳变与持续形变。"
        )
        content: list[dict] = [
            {
                "type": "text",
                "text": (
                    f"监测点 {station.station_name}，时间范围 {begin_time} ~ {end_time} (Asia/Shanghai)，"
                    f"共 {len(points)} 个数据点（全量绘图）。{chart_desc}"
                    "请先报告全窗口整体形态，再按系统提示词要求返回 JSON 观察结果。"
                ),
            },
        ]
        for chart in vision_charts:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{chart['png_base64']}"},
                }
            )

        # 每次工具尝试只调用一次视觉模型；只有瞬时失败交给官方工具重试。
        try:
            structured_llm = _get_vision_llm().with_structured_output(
                VisionObservations, method="json_mode", include_raw=True
            )
            response = await structured_llm.ainvoke(
                [SystemMessage(content=VISION_PROMPT), HumanMessage(content=content)],
                config={"callbacks": []},
            )
        except Exception as e:
            logging.getLogger(__name__).warning("vision model request failed", exc_info=True)
            if is_transient_error(e):
                raise
            return tool_error_result(
                "视觉模型调用失败，未获得形态复核结果；图表可供人工查看。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                artifact=artifact,
            )

        parsed = response.get("parsed") if isinstance(response, dict) else None
        parsing_error = response.get("parsing_error") if isinstance(response, dict) else None
        if parsing_error is not None or not isinstance(parsed, VisionObservations):
            return tool_error_result(
                "视觉复核失败：视觉模型返回的不是有效 JSON；图表可供人工查看。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                artifact=artifact,
            )

        validated = _validate_observations(parsed, time_start, time_end)
        if _is_empty_observation(validated):
            return tool_error_result(
                "视觉模型未返回有效观察，图表可供人工查看。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                artifact=artifact,
            )
        if len(validated.candidates) > settings.vision_max_candidates:
            return tool_error_result(
                "视觉候选数量超过本次复核预算，尚未进行数值确认；请缩小查询时间范围。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                category="budget",
                artifact=artifact,
            )


        # 数值证据（纯数据接口回查，无额外视觉调用）：
        # 全部异常候选经网络回查（首次全量拉取可能被降采样，回查保证窗口内
        # 小时级全分辨率）计算五类数值特征；global_features 为整个调用范围的
        # 同一套数值特征独立覆盖整个调用范围，用于与视觉候选交叉核验
        pad_hours = settings.vision_recheck_pad_hours
        rechecks = await _recheck_candidates(
            client, station.station_uuid, validated.candidates,
            baseline, pad_hours, time_start, time_end,
        )
        observations_out = validated.model_dump()
        observations_out["candidates"] = [
            {**candidate.model_dump(), "features": recheck}
            for candidate, recheck in zip(validated.candidates, rechecks)
        ]
        observations_out["global_features"] = _window_features(points, baseline)
        observations_out["feature_note"] = (
            "candidates[].features 为对相应区间（已向两侧各外扩 "
            f"{max(0, pad_hours)} 小时）经网络回查原始数据（小时级全分辨率）计算的数值特征，"
            "global_features 为整个查询范围的同一套特征："
            "累计位移 cum_start_mm/cum_end_mm（相对基线，mm）、窗口净变化 net_change_mm、"
            "鲁棒斜率 robust_slope_mm_day（Theil–Sen，mm/天）、最大单步变化 max_step_mm 及"
            "发生时刻 max_step_time、跳变前后水平差 level_shift_mm 与跳后持续性 "
            "jump_persistence（持续/回落/样本不足）。"
            "interpretation 为视觉模型的形态学推断（非事实观察），转述时必须保持"
            "“可能/疑似/不排除”等非确定语气。"
            "判断持续形变时优先参考 global_features 的鲁棒斜率与净变化。"
            "向用户转述时必须使用中文业务语言：不得出现 features、global_features、"
            "recheck、interpretation 等字段名与英文判定码；三类结论分别表述为"
            "“数值证据支持 / 存在变化但证据不足 / 复核未获数值支持（视觉误判）”；"
            "核验范围比视觉定位区间略宽时，说明为“核验时向区间两侧适当放宽了时间窗”；"
            "极值出现时刻与候选区间不一致时，应指出实际偏离发生的时间。"
        )
        if any(not item.get("ok") for item in rechecks):
            return tool_error_result(
                "部分视觉候选未能完成数值复核，不能将这些候选认定为已确认变化。",
                tool_call_id=tool_call_id,
                tool_name="analyze_gnss_chart",
                kind="vision",
                facts={"ok": False, **base_result, "observations": observations_out},
                artifact={**artifact, "data": {**base_result, "observations": validated.model_dump()}},
            )
        return tool_result(
            {
                "ok": True,
                **base_result,
                "observations": observations_out,
            },
            kind="vision",
            artifact=artifact,
            display={"ok": True, **base_result, "observations": validated.model_dump()},
        )
