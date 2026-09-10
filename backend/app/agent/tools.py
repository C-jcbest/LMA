"""北斗平台相关的 LangChain 工具，供智能体调用。

凭据当前来自 .env 测试账号（用户选定的最小实现方案），
后续迭代改为用户绑定凭据时只需替换 _build_client。
"""

import json
import math
import re
from datetime import datetime

from langchain_core.tools import tool

from app.beidou.client import BeidouClient
from app.beidou.schemas import Station
from app.config import get_settings

# 返回给 LLM 的 GNSS 数据点上限，超出时截断并注明
_MAX_DATA_POINTS = 500

_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"

# 北斗平台枚举值 → 中文可读描述；仅用于工具返回值转换，
# 入参仍使用平台枚举码（由 LLM 按工具说明完成中文到枚举码的映射）
_STATION_TYPE_TEXT = {
    1: "基准站",
    2: "移动站单点模式",
    3: "移动站RTK模式",
    4: "中继站",
}
_STATION_STATUS_TEXT = {
    10: "正常",
    20: "离线",
    30: "告警",
    40: "故障",
}


def _build_client() -> BeidouClient:
    settings = get_settings()
    return BeidouClient(
        base_url=settings.beidou_api_base_url,
        username=settings.beidou_username,
        password=settings.beidou_password,
    )


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _to_float(value: str | float | int | None) -> float | None:
    """安全转 float，失败返回 None。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _axis_summary(values: list[str]) -> dict:
    """单方向（N/E/U）数值摘要：首末值、变化量、极值。"""
    nums = [v for v in (_to_float(x) for x in values) if v is not None]
    if not nums:
        return {"count": 0}
    return {
        "count": len(nums),
        "first": nums[0],
        "last": nums[-1],
        "change": round(nums[-1] - nums[0], 4),
        "min": min(nums),
        "max": max(nums),
    }


def _detect_gaps(points) -> list[dict]:
    """检测缺失时段：间隔超过中位间隔 3 倍视为缺测，最多报告 20 段。"""
    times = []
    for p in points:
        try:
            times.append(datetime.strptime(p.data_time, _TIME_FORMAT))
        except (TypeError, ValueError):
            return []
    if len(times) < 3:
        return []
    intervals = [
        (times[i + 1] - times[i]).total_seconds() for i in range(len(times) - 1)
    ]
    median = sorted(intervals)[len(intervals) // 2]
    if median <= 0:
        return []
    gaps = []
    for i, sec in enumerate(intervals):
        if sec >= median * 3:
            gaps.append(
                {
                    "from": times[i].strftime(_TIME_FORMAT),
                    "to": times[i + 1].strftime(_TIME_FORMAT),
                    "missing_hours": round(sec / 3600, 1),
                }
            )
    return gaps[:20]


def _validate_time(value: str) -> str:
    datetime.strptime(value, _TIME_FORMAT)
    return value


def _station_to_dict(station: Station) -> dict:
    """精简站点字段并把枚举值转为中文描述，避免工具输出过长且不可读。"""
    return {
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "group_name": station.group_name,
        "station_type": _STATION_TYPE_TEXT.get(
            station.station_type, f"未知类型({station.station_type})"
        ),
        "station_status": _STATION_STATUS_TEXT.get(
            station.station_status, f"未知状态({station.station_status})"
        ),
        "location": station.location,
        "description": station.description,
    }


async def _resolve_station(
    client: BeidouClient, station_name_or_uuid: str
) -> Station | str:
    """把站名或 UUID 解析为唯一站点；无法唯一确定时返回提示字符串。"""
    if _UUID_PATTERN.match(station_name_or_uuid):
        stations = await client.get_stations()
        for station in stations:
            if station.station_uuid == station_name_or_uuid:
                return station
        return f"未找到 UUID 为 {station_name_or_uuid} 的监测点"

    stations = await client.get_stations(station_name=station_name_or_uuid)
    if not stations:
        return f"未找到名称包含“{station_name_or_uuid}”的监测点"
    if len(stations) > 1:
        return (
            f"名称包含“{station_name_or_uuid}”的监测点有 {len(stations)} 个，"
            "请让用户确认具体站点："
            + _dumps([_station_to_dict(s) for s in stations[:20]])
        )
    return stations[0]


@tool
async def list_station_groups() -> str:
    """查询北斗监测平台上当前用户有权访问的全部监测点分组。

    返回分组列表，包含分组名称、分组内监测点数量和分组描述。
    适用于“有哪些分组/分组情况”这类事实查询。
    """
    async with _build_client() as client:
        groups = await client.get_station_groups()
    return _dumps(
        {
            "total": len(groups),
            "groups": [
                {
                    "group_name": g.group_name,
                    "station_count": g.station_count,
                    "description": g.description,
                }
                for g in groups
            ],
        }
    )


@tool
async def list_stations(
    group_name: str | None = None,
    station_name: str | None = None,
    station_status: int | None = None,
) -> str:
    """按条件查询监测点列表。

    Args:
        group_name: 监测点分组名称（精确或模糊匹配分组名，不传则查全部分组）。
        station_name: 监测点名称，支持模糊匹配，不传则返回全部。
        station_status: 监测点状态过滤：10=正常，20=离线，30=告警，40=故障。不传则不限状态。

    返回站点名称、所属分组、类型、状态、位置等摘要信息；
    类型与状态字段已转换为中文描述（如“基准站”“正常”），不返回数字代码。
    """
    async with _build_client() as client:
        group_uuid = None
        if group_name:
            groups = await client.get_station_groups()
            matched = [g for g in groups if group_name in g.group_name]
            if not matched:
                return f"未找到名称包含“{group_name}”的监测点分组"
            if len(matched) > 1:
                return (
                    f"名称包含“{group_name}”的分组有 {len(matched)} 个，"
                    "请让用户确认具体分组："
                    + _dumps(
                        [{"group_name": g.group_name} for g in matched[:20]]
                    )
                )
            group_uuid = matched[0].group_uuid

        stations = await client.get_stations(
            group_uuid=group_uuid,
            station_name=station_name,
            station_status=station_status,
        )
    return _dumps(
        {
            "total": len(stations),
            "stations": [_station_to_dict(s) for s in stations],
        }
    )


@tool
async def get_daily_gnss_data(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    sampling_frequency: str | None = None,
) -> str:
    """查询指定监测点在时间范围内的日监测 GNSS 数据（默认每小时一条）。

    Args:
        station_name_or_uuid: 监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID。
        begin_time: 开始时间，格式必须为 "YYYY-MM-DD HH:mm:ss"。
        end_time: 结束时间，格式必须为 "YYYY-MM-DD HH:mm:ss"，可跨天。
        sampling_frequency: 可选采样频率，如 "1h"/"2h"/"3h"/"6h" 或整数分钟，
            不传则返回默认每小时一条。

    返回的数据点包含时间以及 N（北向坐标，m）、E（东向坐标，m）、U（垂直坐标，m）。
    数据点超过上限时会等间隔降采样（时间范围仍完整覆盖），并附 summary 统计摘要
    （各方向首末值/变化量/极值及缺失时段），趋势分析请优先使用 summary。
    """
    try:
        _validate_time(begin_time)
        _validate_time(end_time)
    except ValueError:
        return (
            f"时间格式错误：begin_time/end_time 必须为 "
            f"{_TIME_FORMAT} 格式，例如 2026-08-01 00:00:00"
        )

    async with _build_client() as client:
        station = await _resolve_station(client, station_name_or_uuid)
        if isinstance(station, str):
            return station

        points = await client.get_daily_data(
            station_uuid=station.station_uuid,
            begin_time=begin_time,
            end_time=end_time,
            sampling_frequency=sampling_frequency,
        )

    # 超过上限时等间隔降采样（保留首末点，时间范围完整覆盖），不再硬截断
    downsampled = len(points) > _MAX_DATA_POINTS
    if downsampled:
        step = math.ceil(len(points) / _MAX_DATA_POINTS)
        sampled = points[::step]
        if sampled[-1] is not points[-1]:
            sampled.append(points[-1])
        points_to_return = sampled
    else:
        points_to_return = points

    return _dumps(
        {
            "station_name": station.station_name,
            "begin_time": begin_time,
            "end_time": end_time,
            "total_points": len(points),
            "returned_points": len(points_to_return),
            "downsampled": downsampled,
            "summary": {
                "n": _axis_summary([p.n for p in points]),
                "e": _axis_summary([p.e for p in points]),
                "u": _axis_summary([p.u for p in points]),
                "gaps": _detect_gaps(points),
            },
            "points": [
                {"time": p.data_time, "n": p.n, "e": p.e, "u": p.u}
                for p in points_to_return
            ],
        }
    )
