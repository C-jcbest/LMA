"""临时调试脚本:检查视觉模型 3 图输入时的原始输出。"""
import asyncio
import json

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.tools import _build_client, _resolve_station
from app.agent.vision import (
    _downsample,
    _get_vision_llm,
    _render_all_charts,
    _VISION_PROMPT,
)


async def main():
    async with _build_client() as client:
        station = await _resolve_station(client, "ZJ-MS10")
        points = await client.get_daily_data(
            station_uuid=station.station_uuid,
            begin_time="2025-10-15 00:00:00",
            end_time="2025-10-31 00:00:00",
        )
    render_points = _downsample(points, 720)
    charts = _render_all_charts(
        render_points, None, "ZJ-MS10", "2025-10-15 00:00:00", "2025-10-31 00:00:00"
    )
    content = [
        {
            "type": "text",
            "text": "监测点 ZJ-MS10，3 张图，请按系统提示词要求返回 JSON 观察结果。",
        }
    ]
    for c in charts:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{c['png_base64']}"},
            }
        )
    resp = await _get_vision_llm().ainvoke(
        [SystemMessage(content=_VISION_PROMPT), HumanMessage(content=content)]
    )
    raw = resp.content if isinstance(resp.content, str) else str(resp.content)
    print("len:", len(raw))
    print("=== first 200 ===")
    print(repr(raw[:200]))
    print("=== last 300 ===")
    print(repr(raw[-300:]))
    try:
        json.loads(raw)
        print("VALID JSON")
    except Exception as e:
        print("invalid:", e)


asyncio.run(main())
