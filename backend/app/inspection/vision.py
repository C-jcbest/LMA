"""巡检原型的视觉初判：把 90 天每日位移画成图，交给视觉模型说一句形态判断。

数值以初筛为准；视觉模型只回答“图形看起来像什么”，结果标注为初判，不改变初筛状态。
"""

import base64
import json
from datetime import datetime
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from statistics import median
from typing import Literal, Sequence

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.agent.models import create_chat_model
from app.beidou.schemas import GnssDataPoint
from app.business_time import TIME_FORMAT
from app.config import get_settings
from app.observations import finite_number

VISION_PROMPT = (Path(__file__).parents[1] / "agent" / "prompts" / "inspection_vision.md").read_text(encoding="utf-8")

_AXES = (("n", "N (mm)"), ("e", "E (mm)"), ("u", "U (mm)"))
_MILLIMETERS_PER_METER = 1000.0
# 显示范围取 2%–98% 分位并留白；个别异常点不再把真实变化压成一条直线。
_LOW_PERCENTILE = 0.02
_HIGH_PERCENTILE = 0.98
_MIN_HALF_RANGE_MM = 2.0
# 相邻日观测间隔超过 1.5 天视为缺测，画成底色。
_GAP_DAYS = 1.5
_VISION_TIMEOUT_SECONDS = 90


class VisionVerdict(BaseModel):
    model_config = {"extra": "ignore"}

    shape: Literal["平稳", "缓慢同向", "台阶", "加速", "往返波动", "数据异常", "难以判断"]
    summary: str = Field(max_length=120)
    data_quality: Literal["正常", "可疑"]
    confidence: Literal["低", "中", "高"]


def vision_configured() -> bool:
    settings = get_settings()
    return bool(settings.vision_base_url and settings.vision_model)


@lru_cache
def _vision_model():
    settings = get_settings()
    return create_chat_model(
        provider=settings.vision_provider,
        model=settings.vision_model,
        api_key=settings.vision_api_key,
        base_url=settings.vision_base_url,
        thinking=settings.vision_thinking,
        protocol=settings.vision_protocol,
        temperature=0,
        max_completion_tokens=2000,
        timeout=_VISION_TIMEOUT_SECONDS,
    )


def _percentile(sorted_values: Sequence[float], fraction: float) -> float:
    index = min(len(sorted_values) - 1, max(0, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[index]


def _display_range(values: Sequence[float]) -> tuple[float, float]:
    ordered = sorted(values)
    low = _percentile(ordered, _LOW_PERCENTILE)
    high = _percentile(ordered, _HIGH_PERCENTILE)
    center = median(ordered)
    half_range = max((high - low) / 2 * 1.3, _MIN_HALF_RANGE_MM)
    middle = (high + low) / 2 if high > low else center
    return middle - half_range, middle + half_range


def render_displacement_chart(points: Sequence[GnssDataPoint], station_name: str) -> bytes:
    """三栏位移图（PNG）。标题和坐标轴只用 ASCII，服务器没有中文字体时也不会乱码。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = [datetime.strptime(point.data_time, TIME_FORMAT) for point in points]
    figure, axes = plt.subplots(3, 1, figsize=(9, 6), sharex=True)
    figure.suptitle(f"Daily displacement, last 90 days - {station_name}", fontsize=11)
    for axis, (key, label) in zip(axes, _AXES):
        raw = [finite_number(getattr(point, key)) for point in points]
        first = next((value for value in raw if value is not None), None)
        axis.set_ylabel(label, fontsize=9)
        axis.grid(True, alpha=0.3)
        if first is None:
            axis.text(0.5, 0.5, "no data", transform=axis.transAxes, ha="center", va="center")
            continue
        series = [(time, (value - first) * _MILLIMETERS_PER_METER) for time, value in zip(times, raw) if value is not None]
        low, high = _display_range([value for _, value in series])
        axis.plot([time for time, _ in series], [min(max(value, low), high) for _, value in series],
                  linewidth=1.1, color="#2563eb")
        above = [(time, high) for time, value in series if value > high]
        below = [(time, low) for time, value in series if value < low]
        if above:
            axis.scatter(*zip(*above), marker="^", color="#dc2626", s=18, zorder=3)
        if below:
            axis.scatter(*zip(*below), marker="v", color="#dc2626", s=18, zorder=3)
        for (start, _), (end, _) in zip(series, series[1:]):
            if (end - start).total_seconds() > _GAP_DAYS * 86400:
                axis.axvspan(start, end, color="#f59e0b", alpha=0.18, linewidth=0)
        axis.set_ylim(low, high)
    figure.autofmt_xdate()
    figure.tight_layout(rect=(0, 0, 1, 0.96))
    buffer = BytesIO()
    figure.savefig(buffer, format="png", dpi=80)
    plt.close(figure)
    return buffer.getvalue()


async def judge_chart(png: bytes, station_name: str, findings: Sequence[str]) -> VisionVerdict:
    """调用视觉模型；失败直接抛出，由调用方把这一站标为“初判失败”，不影响其他测点。"""
    facts = {"station": station_name, "screening_findings": list(findings)}
    image_url = f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"
    content = [
        {"type": "text", "text": json.dumps(facts, ensure_ascii=False)},
        {"type": "image_url", "image_url": {"url": image_url}},
    ]
    structured = _vision_model().with_structured_output(VisionVerdict, method="json_mode")
    # 断开图的流式回调：模型逐字输出的 JSON 不能作为助手消息推给页面，页面只接收解析后的初判组件。
    return await structured.ainvoke(
        [SystemMessage(content=VISION_PROMPT), HumanMessage(content=content)], config={"callbacks": []},
    )
