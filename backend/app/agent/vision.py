"""GNSS 时序图表的视觉复核工具。

用小时级全量数据绘制原始坐标、累计位移与合成位移图，交给视觉模型观察整体形态并标出候选区间；
候选区间在已取得的小时数据上计算数值特征（数值复核不再重新请求平台）。
图片随 artifact 发给前端，不进入模型上下文；模型只读结构化观察与数值特征。
需要看清某一段时由主智能体用更窄的窗口重复调用。
"""

import asyncio
import base64
import logging
from datetime import datetime, timedelta
from functools import lru_cache
from io import BytesIO

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from app.agent.tool_inputs import ChartInput
from app.agent.tool_protocol import ToolFailure, tool_error_result, tool_result
from pydantic import BaseModel, Field, ValidationError

from app.agent.prompting import VISION_PROMPT
from app.agent.numerical import axis_features as _axis_features
from app.agent.retry import is_transient_error
from app.business_time import BUSINESS_TIMEZONE, TIME_FORMAT as _TIME_FORMAT
from app.monitoring_data import BASE_STATION_NOTE, BASE_STATION_TYPE, monitoring
from app.observations import finite_number as _to_float, normalize_observations
from app.config import get_settings
from app.agent.models import create_chat_model

# 渲染使用全量数据，不做降采样（降采样会漏掉采样点之间的异常形态）
_MIN_POINTS = 5  # 少于该点数不值得绘图识别

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
        protocol=settings.vision_protocol,
        temperature=0,
        # 预算必须宽裕：思考开启时视觉模型每次输出中约 2000 token 是
        # 内部思考（reasoning），正文 JSON 另需 ~1000+；预算不足时正文被
        # 截断导致 JSON 解析间歇性失败
        max_completion_tokens=8000,
        timeout=120,
    )



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
    """本工具请求小时数据，图示也按小时识别缺口，不反推观测节奏。"""
    for first, second in zip(times, times[1:]):
        if (second - first).total_seconds() > 5400:
            axis.axvspan(first, second, color="#f59e0b", alpha=0.18, linewidth=0)


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


def _window_features(
    points: list, baseline: tuple[float, float, float] | None
) -> dict:
    """对一段数据点计算三方向形态数值特征（单位 mm）。

    基线优先用监测点初始坐标（StationN0/E0/U0），未登记时各方向回退为窗口首点。
    """
    points, _ = normalize_observations(points)
    if not points:
        return {"points": 0}
    times = [p.data_time for p in points]
    features: dict = {
        "points": len(points),
        "begin_time": times[0],
        "end_time": times[-1],
        "baseline": "监测点初始坐标" if baseline is not None else "固定参考缺失；仅计算窗口变化",
    }
    for key, base_index in (("n", 0), ("e", 1), ("u", 2)):
        base = baseline[base_index] if baseline is not None else None
        features[key] = _axis_features(times, [_to_float(getattr(p, key)) for p in points], base)
    return features


def _recheck_candidate(
    observations: list,
    candidate: VisualCandidate,
    baseline: tuple[float, float, float] | None,
    pad_hours: int,
    time_start: datetime,
    time_end: datetime,
) -> dict:
    """在已取得的小时数据上取候选区间，计算准确数值与形态特征。

    视觉估读时间存在误差，区间先向两侧各外扩 pad_hours 小时（限制在查询窗口内）。
    """
    pad = timedelta(hours=max(0, pad_hours))
    query_start = max(_parse_time(candidate.start_at) - pad, time_start).strftime(_TIME_FORMAT)
    query_end = min(_parse_time(candidate.end_at) + pad, time_end).strftime(_TIME_FORMAT)
    points = [point for point in observations if query_start <= point.data_time <= query_end]
    return {
        "ok": True,
        "begin_time": query_start,
        "end_time": query_end,
        "pad_hours": max(0, pad_hours),
        "points": len(points),
        "summary": {
            axis: _axis_detail([(point.data_time, getattr(point, axis)) for point in points])
            for axis in ("n", "e", "u")
        },
        "features": _window_features(points, baseline),
    }


@tool(response_format="content_and_artifact", args_schema=ChartInput)
async def analyze_gnss_chart(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    tool_call_id: str,
) -> tuple[str | ToolMessage, dict | None]:
    """对移动站一段时间的位移曲线做图形复核：视觉模型观察整体形态并标出候选区间，每个候选附数值特征。

    适合判断形态（持续变化、台阶、尖峰、趋势转折），以及数值特征难以说明的情况。
    视觉候选是待核查的线索，是否成立以数值特征为准；窗口越窄图形分辨率越高。图表同时展示给用户。
    """
    time_start = datetime.strptime(begin_time, _TIME_FORMAT)
    time_end = datetime.strptime(end_time, _TIME_FORMAT)

    async with monitoring() as data:
        station = await data.resolve_station(station_name_or_uuid)
        if station.station_type == BASE_STATION_TYPE:
            return BASE_STATION_NOTE, None
        series = await data.displacement(station, begin_time, end_time, "hourly")

    points = series.observations
    base_result = {
        "quality": series.quality,
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "begin_time": begin_time,
        "end_time": end_time,
        "timezone": BUSINESS_TIMEZONE,
        "total_points": len(points),
    }
    if not points:
        return tool_result(
            {"ok": True, **base_result, "observations": None},
            kind="vision",
            display={**base_result, "ok": True, "images": [], "chart_points": [], "observations": None},
        )
    if len(points) < _MIN_POINTS:
        raise ToolFailure(f"该时段数据点过少（{len(points)} 条），不足以绘图复核")

    chart_points = [{"t": point.data_time, "n": point.n, "e": point.e, "u": point.u} for point in points]
    settings = get_settings()
    baseline = _resolve_baseline(station)
    baseline_desc = "相对监测点初始坐标" if baseline is not None else "相对数据首点（站点未登记初始坐标）"
    # matplotlib 首次导入会同步探测配置目录，放进工作线程避免阻塞事件循环。
    charts = await asyncio.to_thread(_render_all_charts, points, baseline, station.station_name, begin_time, end_time)
    artifact_data = {**base_result, "images": charts, "chart_points": chart_points, "raw_points": series.raw_points}
    if not charts:
        return tool_error_result(
            "图表渲染失败，无法进行视觉复核",
            tool_call_id=tool_call_id, tool_name="analyze_gnss_chart", kind="vision", data=artifact_data,
        )
    if not (settings.vision_base_url and settings.vision_api_key and settings.vision_model):
        return tool_error_result(
            "视觉模型未配置，无法进行图表形态复核；已返回图表供人工查看。",
            tool_call_id=tool_call_id, tool_name="analyze_gnss_chart", kind="vision",
            category="configuration", data=artifact_data,
        )

    # 原始时序与累计位移形态等价（仅差基准）；只送累计与合成两张图，减少视觉模型返回非 JSON 的情况。
    vision_charts = [chart for chart in charts if chart["name"] in (_CHART_CUMULATIVE, _CHART_RESULTANT)] or charts
    chart_notes = {
        _CHART_RAW: "原始坐标 N/E/U 时序（m）",
        _CHART_CUMULATIVE: f"{baseline_desc}的累计位移 ΔN/ΔE/ΔU（mm，橙色阴影为缺测时段）",
        _CHART_RESULTANT: f"{baseline_desc}的合成位移（水平与三维，mm，橙色阴影为缺测时段）",
    }
    chart_desc = "".join(
        f"第 {index} 张图为{chart_notes[chart['name']]}。" for index, chart in enumerate(vision_charts, start=1)
    )
    content: list[dict] = [{
        "type": "text",
        "text": (
            f"监测点 {station.station_name}，时间范围 {begin_time} ~ {end_time} (Asia/Shanghai)，"
            f"共 {len(points)} 个数据点（全量绘图）。{chart_desc}"
            "请先报告全窗口整体形态，再按系统提示词要求返回 JSON 观察结果。"
        ),
    }]
    for chart in vision_charts:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{chart['png_base64']}"}})

    # 每次工具尝试只调用一次视觉模型；只有瞬时失败交给官方工具重试。
    try:
        structured_llm = _get_vision_llm().with_structured_output(VisionObservations, method="json_mode", include_raw=True)
        response = await structured_llm.ainvoke(
            [SystemMessage(content=VISION_PROMPT), HumanMessage(content=content)], config={"callbacks": []},
        )
    except Exception as error:
        logging.getLogger(__name__).warning("vision model request failed", exc_info=True)
        if is_transient_error(error):
            raise
        return tool_error_result(
            "视觉模型调用失败，未获得形态复核结果；图表可供人工查看。",
            tool_call_id=tool_call_id, tool_name="analyze_gnss_chart", kind="vision", data=artifact_data,
        )

    parsed = response.get("parsed") if isinstance(response, dict) else None
    parsing_error = response.get("parsing_error") if isinstance(response, dict) else None
    if parsing_error is not None or not isinstance(parsed, VisionObservations):
        return tool_error_result(
            "视觉复核失败：视觉模型返回的不是有效 JSON；图表可供人工查看。",
            tool_call_id=tool_call_id, tool_name="analyze_gnss_chart", kind="vision", data=artifact_data,
        )

    validated = _validate_observations(parsed, time_start, time_end)
    if len(validated.candidates) > settings.vision_max_candidates:
        return tool_error_result(
            "视觉候选数量超过本次复核预算，尚未进行数值确认；请缩小查询时间范围。",
            tool_call_id=tool_call_id, tool_name="analyze_gnss_chart", kind="vision",
            category="budget", data=artifact_data,
        )

    pad_hours = settings.vision_recheck_pad_hours
    observations_out = validated.model_dump()
    observations_out["candidates"] = [
        {
            **candidate.model_dump(),
            "features": _recheck_candidate(points, candidate, baseline, pad_hours, time_start, time_end),
        }
        for candidate in validated.candidates
    ]
    observations_out["global_features"] = _window_features(points, baseline)
    observations_out["feature_note"] = (
        f"candidates[].features 为候选区间（两侧各外扩 {max(0, pad_hours)} 小时）在小时数据上的数值特征，"
        "global_features 为整个查询窗口的同一套特征（mm、mm/day）。"
        "interpretation 是视觉模型的形态推断，不是数值事实；视觉定位时间有误差，发生时刻以特征中的时刻为准。"
    )
    return tool_result(
        {"ok": True, **base_result, "observations": observations_out},
        kind="vision",
        display={**artifact_data, "ok": True, "observations": validated.model_dump()},
    )
