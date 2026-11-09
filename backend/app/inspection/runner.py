"""手动触发的批量巡检：逐测点读取上游数据、初筛并保存结果。"""

import asyncio
import logging
from collections import defaultdict
from datetime import timedelta
from typing import Callable

import httpx

from app.beidou.client import BeidouApiError, BeidouClient
from app.beidou.schemas import Station
from app.business_time import TIME_FORMAT, business_now
from app.inspection.screening import (
    LONG_WINDOW_DAYS,
    RECENT_WINDOW_DAYS,
    ScreeningResult,
    apply_common_mode,
    screen_station,
)
from app.server.storage import SessionStorage

logger = logging.getLogger(__name__)

# 2=移动站单点模式，3=移动站RTK模式；基准站和中继站没有形变序列，不进入巡检。
_DISPLACEMENT_STATION_TYPES = {2, 3}
_LONG_WINDOW_SAMPLE_TIMES = ["15:00"]
_UPSTREAM_CONCURRENCY = 4


def _to_reference(station: Station) -> dict[str, float | None]:
    def parse(value: str) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    return {"n": parse(station.station_n0), "e": parse(station.station_e0), "u": parse(station.station_u0)}


async def _screen(client: BeidouClient, station: Station, limiter: asyncio.Semaphore) -> ScreeningResult:
    now = business_now().replace(tzinfo=None)
    end_time = now.strftime(TIME_FORMAT)
    try:
        async with limiter:
            long_points = await client.get_daily_data(
                station.station_uuid,
                (now - timedelta(days=LONG_WINDOW_DAYS)).strftime(TIME_FORMAT),
                end_time,
                sample_times=_LONG_WINDOW_SAMPLE_TIMES,
            )
            recent_points = await client.get_daily_data(
                station.station_uuid,
                (now - timedelta(days=RECENT_WINDOW_DAYS)).strftime(TIME_FORMAT),
                end_time,
            )
    except (BeidouApiError, httpx.HTTPError):
        # 单点失败不影响其余测点；原始错误只进日志。
        logger.warning("inspection data request failed", exc_info=True)
        return ScreeningResult("暂无法分析", ["监测平台数据暂不可用"])
    return screen_station(long_points, recent_points, _to_reference(station), now)


async def run_inspection(
    storage: SessionStorage,
    inspection_id: str,
    build_client: Callable[[], BeidouClient],
) -> None:
    status = "error"
    try:
        async with build_client() as client:
            # 先完成一次登录，避免并发请求各自登录。
            stations = [
                station for station in await client.get_stations()
                if station.station_type in _DISPLACEMENT_STATION_TYPES
            ]
            await storage.set_inspection_total(inspection_id, len(stations))
            limiter = asyncio.Semaphore(_UPSTREAM_CONCURRENCY)

            async def screen_and_count(station: Station) -> ScreeningResult:
                result = await _screen(client, station, limiter)
                await storage.increment_inspection_progress(inspection_id)
                return result

            results = await asyncio.gather(*(screen_and_count(station) for station in stations))

        by_group: dict[str, list[ScreeningResult]] = defaultdict(list)
        for station, result in zip(stations, results):
            by_group[station.group_uuid].append(result)
        for group_results in by_group.values():
            apply_common_mode(group_results)

        await storage.save_inspection_stations(inspection_id, list(zip(stations, results)))
        status = "success"
    except asyncio.CancelledError:
        status = "interrupted"
        raise
    except Exception:
        logger.exception("inspection failed: %s", inspection_id)
    finally:
        await asyncio.shield(storage.finish_inspection(inspection_id, status))
