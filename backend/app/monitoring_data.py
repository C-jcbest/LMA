"""监测平台数据入口：模型工具与测点页共用的测点解析、分片取数、会话缓存和清洗。

平台单次请求没有明确上限，但长窗口一次返回过多数据会拖慢请求；这里按固定日历块拆分，
同一会话内追问或窗口重叠时复用已取得的块。缓存只为减少重复请求，过期后重新读取，
不作为业务事实来源。
"""

import asyncio
import re
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from app.agent.tool_protocol import ToolFailure, ToolInputError
from app.beidou.client import BeidouClient
from app.beidou.schemas import GnssDataPoint, Station
from app.business_time import BUSINESS_TIMEZONE, TIME_FORMAT, business_now
from app.config import get_settings
from app.observations import (
    AXES,
    Observation,
    finite_number,
    normalize_observations,
    observation_quality,
    raw_snapshot,
    station_reference,
)

Sampling = Literal["hourly", "daily"]

DAILY_SAMPLE_TIMES = ("15:00",)
# 单次查询窗口上限：小时数据一年约 8800 点，每日固定时刻十年约 3650 点。
MAX_WINDOW_DAYS = {"hourly": 366, "daily": 3660}
_BLOCK_DAYS = {"hourly": 30, "daily": 360}
_BLOCK_EPOCH = datetime(2000, 1, 1)
_CACHE_TTL_SECONDS = 600
_MAX_CACHED_SESSIONS = 32
_UPSTREAM_CONCURRENCY = 4

STATION_TYPE_TEXT = {1: "基准站", 2: "移动站单点模式", 3: "移动站RTK模式", 4: "中继站"}
STATION_STATUS_TEXT = {10: "正常", 20: "离线", 30: "告警", 40: "故障"}
BASE_STATION_TYPE = 1
DISPLACEMENT_STATION_TYPES = {2, 3}
# 基准站不是故障也不是缺测；工具直接回答这一点，不生成失败卡片。
BASE_STATION_NOTE = "未查询形变数据：该监测点为基准站，仅提供差分基准，不适用移动站形变序列分析；这不表示监测异常。"

_UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_NAME_TOKEN_PATTERN = re.compile(r"[a-z]+|\d+|[一-鿿]+")
# 口语里指代测点的通用说法，不参与名称匹配：“3 号点”只看 3。
_GENERIC_NAME_WORDS = ("监测点", "测点", "号点", "号", "点", "站")


def _name_tokens(text: str) -> list[str]:
    tokens = []
    for token in _NAME_TOKEN_PATTERN.findall(text.lower()):
        for word in _GENERIC_NAME_WORDS:
            token = token.replace(word, "")
        if token:
            tokens.append(token)
    return tokens


def station_name_matches(query: str, name: str) -> bool:
    """名称模糊匹配：按字母、数字、汉字分词比较，查询里的每个词都要在名称里找到对应。

    用户常说“ST3”“3 号点”“st-03”，平台名称是“DEMO-ST03”：数字按数值比较（3 与 03 相同，
    1 与 10 不同，避免 MS1 命中 MS10），字母和汉字按包含比较，分隔符忽略。
    """
    query_tokens = _name_tokens(query)
    name_tokens = _name_tokens(name)
    if not query_tokens:
        return False

    def token_found(token: str) -> bool:
        if token.isdigit():
            return any(item.isdigit() and int(item) == int(token) for item in name_tokens)
        return any(token in item for item in name_tokens)

    return all(token_found(token) for token in query_tokens)


def build_platform_client() -> BeidouClient:
    settings = get_settings()
    return BeidouClient(
        base_url=settings.beidou_api_base_url,
        username=settings.beidou_username,
        password=settings.beidou_password,
    )


def station_summary(station: Station) -> dict:
    """平台枚举转为中文，坐标转为数值；只保留业务需要的字段。"""
    return {
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "group_name": station.group_name,
        "station_type": STATION_TYPE_TEXT.get(station.station_type, f"未知类型({station.station_type})"),
        "station_status": STATION_STATUS_TEXT.get(station.station_status, f"未知状态({station.station_status})"),
        "location": station.location,
        "description": station.description,
        "latitude": finite_number(station.latitude),
        "longitude": finite_number(station.longitude),
        "altitude": finite_number(station.altitude),
        "coordinate_system": "WGS84",
    }


@dataclass
class _Block:
    points: list[GnssDataPoint]
    fetched_at: float


class _SeriesCache:
    """一个会话已取得的日历块；跨运行保留，过期即重新读取。"""

    def __init__(self):
        self.blocks: dict[tuple, _Block] = {}

    def fresh(self, key: tuple) -> _Block | None:
        block = self.blocks.get(key)
        if block is None or time.monotonic() - block.fetched_at > _CACHE_TTL_SECONDS:
            return None
        return block


_session_caches: OrderedDict[str, _SeriesCache] = OrderedDict()


def _cache_for(session_id: str | None) -> _SeriesCache:
    if session_id is None:
        return _SeriesCache()
    cache = _session_caches.pop(session_id, None) or _SeriesCache()
    _session_caches[session_id] = cache
    while len(_session_caches) > _MAX_CACHED_SESSIONS:
        _session_caches.popitem(last=False)
    return cache


@dataclass
class DisplacementSeries:
    """清洗后的单站序列；质量统计按请求采样日历计算，原始快照保留供复核。"""

    station: Station
    begin_time: str
    end_time: str
    sampling: Sampling
    sample_times: list[str] | None
    observations: list[Observation]
    raw_points: list[dict]
    quality: dict
    acquired_at: str
    reference: dict = field(init=False)

    def __post_init__(self):
        self.reference = station_reference(self.station)

    @property
    def cadence_hours(self) -> float:
        return 24.0 if self.sampling == "daily" else 1.0


class MonitoringData:
    """一次运行内的平台访问：共用登录、测点台账、并发上限和会话缓存。"""

    def __init__(self, cache: _SeriesCache, client_factory):
        self._cache = cache
        self._client_factory = client_factory
        self._client: BeidouClient | None = None
        self._stations: list[Station] | None = None
        self._station_lock = asyncio.Lock()
        self._block_locks: dict[tuple, asyncio.Lock] = {}
        self._limiter = asyncio.Semaphore(_UPSTREAM_CONCURRENCY)

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def client(self) -> BeidouClient:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    async def stations(self) -> list[Station]:
        async with self._station_lock:
            if self._stations is None:
                self._stations = await self.client().get_stations()
            return self._stations

    async def groups(self):
        return await self.client().get_station_groups()

    async def resolve_station(self, name_or_uuid: str) -> Station:
        """站名或 UUID 解析为唯一测点；有歧义时列出候选让用户确认。"""
        stations = await self.stations()
        if _UUID_PATTERN.match(name_or_uuid):
            for station in stations:
                if station.station_uuid == name_or_uuid:
                    return station
            raise ToolFailure("未找到指定 UUID 对应的监测点，请确认站点。")
        matched = [station for station in stations if station_name_matches(name_or_uuid, station.station_name)]
        if not matched:
            raise ToolFailure(f"未找到名称包含“{name_or_uuid}”的监测点")
        # 模糊匹配可能命中多个测点，名称完全一致的站点优先。
        exact = [station for station in matched if station.station_name == name_or_uuid]
        if len(exact) == 1:
            return exact[0]
        if len(matched) > 1:
            names = [f"{item.station_name}（{item.group_name}，{item.station_uuid}）" for item in matched[:20]]
            raise ToolFailure(f"匹配到 {len(matched)} 个监测点，请确认具体站点：" + "、".join(names))
        return matched[0]

    async def displacement(
        self, station: Station, begin_time: str, end_time: str,
        sampling: Sampling = "hourly", sample_times: list[str] | None = None,
    ) -> DisplacementSeries:
        if station.station_type == BASE_STATION_TYPE:
            raise ToolFailure(BASE_STATION_NOTE)
        start = datetime.strptime(begin_time, TIME_FORMAT)
        end = datetime.strptime(end_time, TIME_FORMAT)
        if start >= end:
            raise ToolInputError("查询窗口必须正向")
        if end - start > timedelta(days=MAX_WINDOW_DAYS[sampling]):
            raise ToolInputError(f"{sampling} 单次查询最多 {MAX_WINDOW_DAYS[sampling]} 天，请缩短窗口、分段查询或改用每日采样")
        times = None
        if sampling == "daily":
            times = list(sample_times or DAILY_SAMPLE_TIMES)

        blocks = await asyncio.gather(*(
            self._block(station.station_uuid, sampling, times, index)
            for index in _block_indexes(start, end, sampling)
        ))
        points = [point for block in blocks for point in block.points]
        normalized, cleaning = normalize_observations(points, begin_time, end_time)
        quality = observation_quality(normalized, begin_time, end_time, sample_times=times, cleaning=cleaning)
        oldest_fetch = min(block.fetched_at for block in blocks)
        acquired_at = business_now() - timedelta(seconds=time.monotonic() - oldest_fetch)
        return DisplacementSeries(
            station=station, begin_time=begin_time, end_time=end_time, sampling=sampling,
            sample_times=times, observations=normalized,
            raw_points=raw_snapshot([point for point in points if begin_time <= point.data_time <= end_time]),
            quality=quality, acquired_at=acquired_at.isoformat(timespec="seconds"),
        )

    async def _block(self, station_uuid: str, sampling: Sampling, sample_times: list[str] | None, index: int) -> _Block:
        key = (station_uuid, sampling, tuple(sample_times or ()), index)
        lock = self._block_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.fresh(key)
            if cached is not None:
                return cached
            block_start = _BLOCK_EPOCH + timedelta(days=index * _BLOCK_DAYS[sampling])
            block_end = block_start + timedelta(days=_BLOCK_DAYS[sampling]) - timedelta(seconds=1)
            now = business_now().replace(tzinfo=None)
            if block_start > now:
                # 窗口结束时间晚于现在时，未来的日历块没有观测，也不缓存。
                return _Block(points=[], fetched_at=time.monotonic())
            async with self._limiter:
                points = await self.client().get_daily_data(
                    station_uuid=station_uuid,
                    begin_time=block_start.strftime(TIME_FORMAT),
                    end_time=min(block_end, now).strftime(TIME_FORMAT),
                    sample_times=sample_times,
                )
            block = _Block(points=points, fetched_at=time.monotonic())
            self._cache.blocks[key] = block
            return block


def _block_indexes(start: datetime, end: datetime, sampling: Sampling) -> range:
    days = _BLOCK_DAYS[sampling]
    first = (start - _BLOCK_EPOCH).days // days
    last = (end - _BLOCK_EPOCH).days // days
    return range(first, last + 1)


_current: ContextVar[MonitoringData | None] = ContextVar("lma_monitoring_data", default=None)


@asynccontextmanager
async def monitoring_scope(session_id: str | None = None, client_factory=None):
    """一次运行的平台访问范围；退出时关闭连接，会话缓存保留给后续追问。"""
    data = MonitoringData(_cache_for(session_id), client_factory or build_platform_client)
    token = _current.set(data)
    try:
        yield data
    finally:
        _current.reset(token)
        await data.aclose()


@asynccontextmanager
async def monitoring():
    """工具使用当前运行的范围；单独调用（测试、评估）时临时建立一个。"""
    data = _current.get()
    if data is not None:
        yield data
        return
    async with monitoring_scope() as scoped:
        yield scoped


def displacement_mm(observation: Observation, reference: dict) -> dict:
    """相对平台固定参考的位移（mm）；参考缺失的方向为 None，不用窗口首点替代。"""
    values = {}
    for axis in AXES:
        value = getattr(observation, axis)
        base = reference.get(axis)
        values[f"d{axis}"] = None if value is None or base is None else round((value - base) * 1000, 3)
    return values


def series_artifact_data(
    series: DisplacementSeries,
    *,
    features: dict | None = None,
    rate_sequence: dict | None = None,
    comparisons: dict | None = None,
    group_stations: list[Station] | None = None,
) -> dict:
    """GNSS 序列的客户端展示结构；工具产物与测点页共用，前端用同一张时间轴绘制。"""
    station = series.station
    points = [observation.as_dict() for observation in series.observations]
    return {
        "station_uuid": station.station_uuid,
        "station_name": station.station_name,
        "begin_time": series.begin_time,
        "end_time": series.end_time,
        "timezone": BUSINESS_TIMEZONE,
        "acquired_at": series.acquired_at,
        "coordinate_unit": "m",
        "summary_unit": "m",
        "total_points": len(points),
        "returned_points": len(points),
        "downsampled": False,
        "sampling": {
            "mode": "sample_times" if series.sampling == "daily" else "hourly",
            "sample_times": series.sample_times,
            "points_limit": len(points),
        },
        "summary": {
            **{axis: _axis_summary([getattr(observation, axis) for observation in series.observations]) for axis in AXES},
            "gaps": series.quality["gaps"],
        },
        "quality": series.quality,
        "reference": {
            "coordinates_m": series.reference,
            "device_uuid": station.device_uuid,
            "applicability": "获取时平台登记的固定参考；平台未提供变更历史，不能据此认定迁站或换设备前后可直接拼接",
        },
        "features": features or {},
        "rate_sequence": rate_sequence,
        "comparisons": comparisons or {},
        "location": {
            "group_name": station.group_name,
            "latitude": finite_number(station.latitude),
            "longitude": finite_number(station.longitude),
            "coordinate_system": "WGS84",
            "group_stations": [
                {
                    "station_uuid": other.station_uuid,
                    "station_name": other.station_name,
                    "station_type": STATION_TYPE_TEXT.get(other.station_type),
                    "latitude": finite_number(other.latitude),
                    "longitude": finite_number(other.longitude),
                }
                for other in group_stations or []
            ],
        },
        "raw_points": series.raw_points,
        "points": points,
    }


def _axis_summary(values: list[float | None]) -> dict:
    numbers = [value for value in values if value is not None]
    if not numbers:
        return {"count": 0}
    return {
        "count": len(numbers), "first": numbers[0], "last": numbers[-1],
        "change": numbers[-1] - numbers[0], "min": min(numbers), "max": max(numbers),
    }
