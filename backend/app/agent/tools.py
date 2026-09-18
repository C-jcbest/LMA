"""北斗平台相关的 LangChain 工具，供智能体调用。

凭据当前来自 .env 测试账号（用户选定的最小实现方案），
后续迭代改为用户绑定凭据时只需替换 _build_client。
"""

import math
import re
from datetime import datetime

from langchain_core.tools import tool
from app.agent.tool_protocol import ToolFailure, tool_result
from app.agent.tool_inputs import StationListInput, GnssInput, _parse_frequency_minutes

from app.beidou.client import BeidouClient
from app.beidou.schemas import Station
from app.config import get_settings
from app.business_time import BUSINESS_TIMEZONE, TIME_FORMAT, business_now

# 返回给 LLM 的 GNSS 数据点上限：超出时优先在请求前调整采样间隔（或按天抽稀），
# 仍超出再等间隔降采样，保证返回数据量不超过该值
_MAX_DATA_POINTS = 1500

_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

_TIME_FORMAT = TIME_FORMAT

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



def _thin_days(points: list, stride: int) -> list:
    """固定时刻模式的数据量控制：按天抽稀，并保留时间范围末端。

    同一保留天内的全部固定时刻点都保留，跨天固定时刻对比关系不被破坏。
    """
    if stride <= 1 or not points:
        return points
    days: list[str] = []
    for p in points:
        day = p.data_time[:10]
        if not days or days[-1] != day:
            days.append(day)
    keep = {day for i, day in enumerate(days) if i % stride == 0}
    keep.add(days[-1])
    return [p for p in points if p.data_time[:10] in keep]


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
        "latitude": _to_float(station.latitude),
        "longitude": _to_float(station.longitude),
        "altitude": _to_float(station.altitude),
        "coordinate_system": "WGS84",
    }


async def _resolve_station(
    client: BeidouClient, station_name_or_uuid: str
) -> Station:
    """把站名或 UUID 解析为唯一站点；无法唯一确定时抛出受控业务异常。"""
    if _UUID_PATTERN.match(station_name_or_uuid):
        stations = await client.get_stations()
        for station in stations:
            if station.station_uuid == station_name_or_uuid:
                return station
        raise ToolFailure("未找到指定 UUID 对应的监测点，请确认站点。")

    stations = await client.get_stations(station_name=station_name_or_uuid)
    if not stations:
        raise ToolFailure(f"未找到名称包含“{station_name_or_uuid}”的监测点")
    if len(stations) > 1:
        names = [item.station_name for item in stations[:20]]
        raise ToolFailure(f"匹配到 {len(stations)} 个监测点，请确认具体站点：" + "、".join(names))
    return stations[0]


@tool(response_format="content_and_artifact")
def get_current_time() -> tuple[str, dict]:
    """获取服务器当前的业务时间与时区（Asia/Shanghai 时区）。

    唯一返回服务器当前时间。当需要确定当前时间以组织后续数据查询、计算相对日期（如“今天”、“昨天”、“最近几天”）时调用。
    """
    now = business_now()
    return tool_result(
        {
            "current_time": now.strftime(TIME_FORMAT),
            "timezone": BUSINESS_TIMEZONE,
        }
    )


@tool(response_format="content_and_artifact")
async def list_station_groups() -> tuple[str, dict]:
    """查询北斗监测平台上当前用户有权访问的全部监测点分组。

    返回分组列表，包含分组名称、分组内监测点数量和分组描述。
    """
    async with _build_client() as client:
        groups = await client.get_station_groups()
    if not groups:
        return tool_result(
            {
                "total": 0,
                "groups": [],
                "message": "当前账号没有可访问的监测点分组。",
            }
        )
    return tool_result(
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


@tool(response_format="content_and_artifact", args_schema=StationListInput)
async def list_stations(
    group_name: str | None = None,
    station_name: str | None = None,
    station_status: int | None = None,
) -> tuple[str, dict]:
    """按条件查询监测点列表。

    Args:
        group_name: 监测点分组名称（精确或模糊匹配分组名，不传则查全部分组）。
        station_name: 监测点名称，支持模糊匹配，不传则返回全部。
        station_status: 监测点状态过滤：10=正常，20=离线，30=告警，40=故障。不传则不限状态。

    返回站点名称、所属分组、类型、状态、位置、WGS84 经纬度和海拔等摘要信息；
    类型与状态字段已转换为中文描述（如“基准站”“正常”），不返回数字代码。
    """
    async with _build_client() as client:
        group_uuid = None
        if group_name:
            groups = await client.get_station_groups()
            matched = [g for g in groups if group_name in g.group_name]
            if not matched:
                raise ToolFailure(f"未找到名称包含“{group_name}”的监测点分组")
            if len(matched) > 1:
                raise ToolFailure(f"匹配到 {len(matched)} 个分组，请确认具体分组：" + "、".join(g.group_name for g in matched[:20]))
            group_uuid = matched[0].group_uuid

        stations = await client.get_stations(
            group_uuid=group_uuid,
            station_name=station_name,
            station_status=station_status,
        )
    if not stations:
        return tool_result(
            {
                "total": 0,
                "stations": [],
                "message": "未找到符合筛选条件的监测点。",
            }
        )
    return tool_result(
        {
            "total": len(stations),
            "stations": [_station_to_dict(s) for s in stations],
        }
    )


@tool(response_format="content_and_artifact", args_schema=GnssInput)
async def get_daily_gnss_data(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    sampling_frequency: str | None = None,
    sample_times: list[str] | None = None,
) -> tuple[str, dict]:
    """查询指定监测点在时间范围内的日监测 GNSS 数据（默认每小时一条）。

    Args:
        station_name_or_uuid: 监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID。
        begin_time: 开始时间，业务时区 Asia/Shanghai，格式必须为 "YYYY-MM-DD HH:mm:ss"。
        end_time: 结束时间，格式必须为 "YYYY-MM-DD HH:mm:ss"，可跨天。
        sampling_frequency: 可选采样频率，如 "1h"/"2h"/"3h"/"6h" 或整数分钟，
            不传则返回默认每小时一条。
        sample_times: 可选固定每日取样时刻（Asia/Shanghai），如 ["03:00", "15:00"]（必须为整点，HH:mm），
            传入后优先于 sampling_frequency。

    返回的数据点包含时间以及 N（北向坐标，m）、E（东向坐标，m）、U（垂直坐标，m）。
    数据量自动控制：预计超过 1500 条时自动调整采样间隔（固定时刻模式按天抽稀），
    仍超出时等间隔降采样（时间范围仍完整覆盖），调整方式记录在 sampling 字段；
    并附 summary 统计摘要（各方向首末值/变化量/极值及缺失时段）。
    """
    normalized_sample_times = sample_times

    # 请求前规划数据量：估算点数超上限时先调整采样间隔，避免拉回超量数据
    time_start = datetime.strptime(begin_time, _TIME_FORMAT)
    time_end = datetime.strptime(end_time, _TIME_FORMAT)
    total_minutes = (time_end - time_start).total_seconds() / 60
    notes: list[str] = []
    day_stride = 0
    effective_frequency = sampling_frequency
    if normalized_sample_times:
        if sampling_frequency:
            notes.append("已按固定每日时刻取样，sampling_frequency 被忽略（固定时刻优先）")
        days = max(1, math.ceil(total_minutes / 1440))
        expected = days * len(normalized_sample_times)
        if expected > _MAX_DATA_POINTS:
            day_stride = math.ceil(expected / _MAX_DATA_POINTS)
            notes.append(
                f"固定时刻模式预计约 {expected} 条数据（{days} 天 × {len(normalized_sample_times)} 个时刻），"
                f"超过 {_MAX_DATA_POINTS} 条上限，返回时按每 {day_stride} 天取一天抽稀（保留全部指定时刻）"
            )
    else:
        freq_minutes = _parse_frequency_minutes(sampling_frequency) if sampling_frequency else None
        base_minutes = freq_minutes or 60
        expected = math.ceil(total_minutes / base_minutes)
        if expected > _MAX_DATA_POINTS:
            hour_step = math.ceil(total_minutes / _MAX_DATA_POINTS / 60)
            effective_frequency = f"{hour_step}h" if hour_step <= 6 else str(hour_step * 60)
            notes.append(
                f"按 {sampling_frequency or '默认每小时'} 采样预计约 {expected} 条数据，"
                f"超过 {_MAX_DATA_POINTS} 条上限，已自动调整为每 {effective_frequency} 一条"
                "；查询时间范围仍完整覆盖，但短时波动细节可能因抽稀而缺失"
            )

    async with _build_client() as client:
        station = await _resolve_station(client, station_name_or_uuid)
        if station.station_type == 1:
            raise ToolFailure("该监测点为基准站，仅提供差分基准，不适用普通移动站形变序列分析；这不表示监测异常。")

        points = await client.get_daily_data(
            station_uuid=station.station_uuid,
            begin_time=begin_time,
            end_time=end_time,
            sampling_frequency=None if normalized_sample_times else effective_frequency,
            sample_times=normalized_sample_times,
        )

    if not points:
        return tool_result(
            {
                "station_name": getattr(station, "station_name", station_name_or_uuid),
                "begin_time": begin_time,
                "end_time": end_time,
                "timezone": BUSINESS_TIMEZONE,
                "total_points": 0,
                "returned_points": 0,
                "downsampled": False,
                "points": [],
                "summary": {
                    "n": {"count": 0},
                    "e": {"count": 0},
                    "u": {"count": 0},
                    "gaps": [],
                },
                "message": "查询时间范围内没有 GNSS 数据，不能据此判断形变。",
            }
        )
    total_points = len(points)

    # 固定时刻模式：按天抽稀（保留全部指定时刻，仅减少参与对比的天数）
    if normalized_sample_times and day_stride > 1:
        points = _thin_days(points, day_stride)

    # 数据量硬上限：平台实际返回量仍超限时等间隔降采样，并在结果元数据中明确披露
    downsampled = len(points) > _MAX_DATA_POINTS
    if downsampled:
        step = math.ceil(len(points) / _MAX_DATA_POINTS)
        sampled = points[::step]
        if sampled[-1] is not points[-1]:
            sampled.append(points[-1])
        points_to_return = sampled
    else:
        points_to_return = points

    mode = (
        "sample_times"
        if normalized_sample_times
        else ("frequency" if effective_frequency else "hourly")
    )
    return tool_result(
        {
            "station_name": station.station_name,
            "begin_time": begin_time,
            "end_time": end_time,
            "timezone": BUSINESS_TIMEZONE,
            "total_points": total_points,
            "returned_points": len(points_to_return),
            "downsampled": downsampled or day_stride > 1,
            "sampling": {
                "mode": mode,
                "sample_times": normalized_sample_times,
                "frequency_effective": None if normalized_sample_times else effective_frequency,
                "frequency_requested": sampling_frequency,
                "day_stride": day_stride or None,
                "points_limit": _MAX_DATA_POINTS,
                "note": "；".join(notes) if notes else None,
            },
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
