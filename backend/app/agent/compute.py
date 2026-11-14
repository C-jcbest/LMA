"""compute：在本会话已取得的依据上做小规模计算，结果本身也是可引用的依据。

模型心算容易出错、用户也无法复核；超出简单比较的统计（分段汇总、自定义窗口、降雨与位移对照等）
交给这里在子进程中计算。数据只来自本会话的依据，不重新请求平台。
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Annotated

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import ToolMessage
from pydantic import Field

from app.agent.compute_runner import validate_code
from app.agent.message_context import evidence_id
from app.agent.tool_protocol import ToolFailure, ToolInputError, tool_result
from app.config import get_settings

_RUNNER = Path(__file__).with_name("compute_runner.py")
_MAX_RESULT_CHARS = 20000


def _evidence_messages(messages) -> dict[str, ToolMessage]:
    return {
        evidence_id(message.tool_call_id): message
        for message in messages
        if isinstance(message, ToolMessage) and isinstance(message.artifact, dict)
    }


def _dataset(identifier: str, message: ToolMessage | None) -> tuple[dict, str]:
    """把依据转换成子进程可重建的数据；返回数据和给用户看的简短说明。"""
    if message is None:
        raise ToolInputError(f"依据 {identifier} 不在本会话中；只能使用工具结果末尾标注的依据编号")
    artifact = message.artifact
    if artifact.get("status") == "error":
        raise ToolInputError(f"依据 {identifier} 是失败的查询，没有可计算的数据")
    data = artifact["data"]
    kind = artifact["kind"]
    if kind == "station_overview":
        # 概览的最后一个窗口是近期小时序列；长期序列的自定义计算由模型另取该窗口。
        data = data["windows"][-1]
        kind = "gnss_series"
    if kind == "gnss_series":
        reference = data.get("reference", {}).get("coordinates_m", {})
        payload = {
            "kind": "gnss",
            "station_name": data["station_name"],
            "reference": {axis: reference.get(axis) for axis in ("n", "e", "u")},
            "points": [[point["time"], point.get("n"), point.get("e"), point.get("u")] for point in data["points"]],
        }
        return payload, f"{data['station_name']} 位移 {data['begin_time']} 至 {data['end_time']}"
    if kind == "weather":
        tables = {}
        history = data.get("history") or {}
        if history.get("daily"):
            tables["daily"] = history["daily"]
        if history.get("hourly"):
            tables["hourly"] = history["hourly"]
        forecast = data.get("forecast") or {}
        if forecast.get("daily"):
            tables["forecast"] = forecast["daily"]
        location = data["location"].get("station_name") or "坐标位置"
        query = data["query"]
        return {"kind": "weather", "tables": tables}, f"{location} 天气 {query['history_start_date']} 至 {query['history_end_date']}"
    if kind == "computation":
        return {"kind": "value", "value": data["result"]}, f"计算结果：{data['description']}"
    raise ToolInputError(f"依据 {identifier} 的类型不支持计算；可用位移、天气或已有计算结果")


def _run_sandbox(request: dict) -> dict:
    environment = {"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    if os.name == "nt":
        # Windows 上 numpy 加载依赖系统目录。
        environment["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    with tempfile.TemporaryDirectory() as workdir:
        completed = subprocess.run(
            [sys.executable, "-I", str(_RUNNER)],
            input=json.dumps(request, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8",
            cwd=workdir, env=environment, timeout=get_settings().compute_timeout_seconds,
        )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise ToolFailure("计算进程异常退出，未得到结果；可能超出内存限制，请减少数据量后重试")
    return json.loads(completed.stdout)


@tool(response_format="content_and_artifact")
async def compute(
    description: Annotated[str, Field(min_length=1, max_length=120, description="一句话说明要算什么，会展示给用户")],
    code: Annotated[str, Field(min_length=1, max_length=4000, description="Python 计算代码，最终结果赋值给 result")],
    inputs: Annotated[list[str], Field(min_length=1, max_length=8, description="本会话依据编号，例如 [\"E1a2b3c\"]")],
    runtime: ToolRuntime,
):
    """在本会话已取得的位移或天气依据上做计算，例如按周汇总位移、任意子窗口净变化、降雨前后速率对比、
    两站差值、变化前若干天累计雨量。数据已在会话中，不重新请求平台。

    代码中可用 pd、np、math、statistics；data[依据编号] 是对应数据，只有一个输入时也可直接用 df。
    - 位移：DataFrame，时间索引，列 n/e/u 为原始坐标（m），dn/de/du/dh/dd 为相对平台固定参考的位移（mm，参考缺失时为 NaN）。
    - 天气：字典，可能含 "daily"（逐日，precipitation_sum 等）、"hourly"（逐小时 precipitation）、"forecast"，均为时间索引 DataFrame。
    - 已有计算结果：原样的 JSON 值。
    把最终结果赋值给 result（数值、字典、Series 或 DataFrame，表格最多返回 200 行）；print 的内容也会返回。
    result 会原样以表格展示给用户：字典的键、列名和索引用简短的中文业务名称并注明单位（如“累计降雨(mm)”）；
    几组同类指标（如前后两段的天数、雨量、最大日雨量）用 DataFrame 每组一行，不要嵌套字典。
    除 pandas、numpy、math、statistics 外不能导入其他模块，也不能读写文件。
    """
    try:
        validate_code(code)
    except ValueError as error:
        raise ToolInputError(str(error)) from None
    messages = _evidence_messages(runtime.state["messages"])
    datasets = {}
    described_inputs = []
    for identifier in dict.fromkeys(inputs):
        payload, summary = _dataset(identifier, messages.get(identifier))
        datasets[identifier] = payload
        described_inputs.append({"evidence_id": identifier, "description": summary})

    try:
        outcome = await asyncio.to_thread(_run_sandbox, {"code": code, "datasets": datasets})
    except subprocess.TimeoutExpired:
        raise ToolInputError("计算超时，请减少数据量或简化计算") from None
    if not outcome["ok"]:
        raise ToolInputError(f"计算未完成：{outcome['error']}")
    serialized = json.dumps(outcome["result"], ensure_ascii=False)
    if len(serialized) > _MAX_RESULT_CHARS:
        raise ToolInputError("结果过大，请先汇总（例如按天或按周聚合、只保留需要的列）再返回")

    result = {"description": description, "result": outcome["result"], "truncated": outcome["truncated"]}
    display = {**result, "code": code, "inputs": described_inputs}
    # 中间打印只给模型参考，不进入展示依据。
    facts = {**result, "printed": outcome["printed"]} if outcome.get("printed") else result
    return tool_result(facts, kind="computation", display=display)
