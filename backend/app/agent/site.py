"""场地空间环境调查工具。

站点与同组点来自北斗平台；地形来自 Open-Meteo/Copernicus DEM；
地质单元来自 Macrostrat。外部数据只作为带来源的辅助证据。
"""

import asyncio
import math
import logging
from typing import Any

import httpx
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from app.agent.tool_inputs import SiteEnvironmentInput
from app.agent.tool_protocol import ToolFailure, tool_error_result, tool_result

from app.agent.tools import _build_client, _resolve_station, _station_to_dict
from app.business_time import business_now

ELEVATION_ENDPOINT = "https://api.open-meteo.com/v1/elevation"
GEOLOGY_ENDPOINT = "https://macrostrat.org/api/v2/geologic_units/map"
REQUEST_TIMEOUT_SECONDS = 20.0


def _offset_coordinate(latitude: float, longitude: float, east_m: float, north_m: float) -> tuple[float, float]:
    """在局部尺度把米偏移近似换算为 WGS84 经纬度。"""
    lat_delta = north_m / 111_320.0
    lon_scale = max(1e-6, 111_320.0 * math.cos(math.radians(latitude)))
    return latitude + lat_delta, longitude + east_m / lon_scale


def _terrain_sample_points(latitude: float, longitude: float) -> tuple[list[tuple[float, float]], dict[str, int]]:
    offsets = [-500.0, -250.0, 0.0, 250.0, 500.0]
    points = [_offset_coordinate(latitude, longitude, east, north) for north in offsets for east in offsets]
    index = {"west": len(points), "east": len(points) + 1, "south": len(points) + 2, "north": len(points) + 3}
    points.extend(
        [
            _offset_coordinate(latitude, longitude, -90.0, 0.0),
            _offset_coordinate(latitude, longitude, 90.0, 0.0),
            _offset_coordinate(latitude, longitude, 0.0, -90.0),
            _offset_coordinate(latitude, longitude, 0.0, 90.0),
        ]
    )
    return points, index


def _aspect_label(degrees: float) -> str:
    labels = ("北", "东北", "东", "东南", "南", "西南", "西", "西北")
    return labels[int((degrees + 22.5) // 45) % 8]


def _terrain_metrics(elevations: list[Any], index: dict[str, int]) -> dict[str, Any] | None:
    try:
        values = [float(value) for value in elevations]
        west, east = values[index["west"]], values[index["east"]]
        south, north = values[index["south"]], values[index["north"]]
    except (IndexError, TypeError, ValueError):
        return None
    if not values or not all(math.isfinite(value) for value in values):
        return None

    dz_dx = (east - west) / 180.0
    dz_dy = (north - south) / 180.0
    slope = math.degrees(math.atan(math.hypot(dz_dx, dz_dy)))
    aspect = math.degrees(math.atan2(-dz_dx, -dz_dy)) % 360.0
    grid = values[:25]
    return {
        "dem_elevation_m": round(grid[12], 1),
        "slope_degrees": round(slope, 1),
        "aspect_degrees": round(aspect, 1),
        "aspect": _aspect_label(aspect),
        "relief_500m_m": round(max(grid) - min(grid), 1),
        "resolution_m": 90,
    }


async def _fetch_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
        response = await client.get(url, params=params)
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


async def _fetch_terrain(latitude: float, longitude: float) -> tuple[dict[str, Any] | None, str | None]:
    points, index = _terrain_sample_points(latitude, longitude)
    try:
        payload = await _fetch_json(
            ELEVATION_ENDPOINT,
            {
                "latitude": ",".join(f"{lat:.7f}" for lat, _ in points),
                "longitude": ",".join(f"{lon:.7f}" for _, lon in points),
            },
        )
        metrics = _terrain_metrics(payload.get("elevation", []), index)
        return metrics, None if metrics else "地形服务返回的数据不完整"
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logging.getLogger(__name__).warning("site evidence request failed", exc_info=True)
        return None, "地形服务暂不可用，缺少地形证据"


async def _fetch_geology(latitude: float, longitude: float) -> tuple[dict[str, Any] | None, str | None]:
    try:
        payload = await _fetch_json(GEOLOGY_ENDPOINT, {"lat": latitude, "lng": longitude})
        success = payload.get("success") if isinstance(payload.get("success"), dict) else {}
        units = success.get("data") if isinstance(success.get("data"), list) else []
        if not units:
            return None, "该位置未获得可用地质单元"
        unit = units[0] if isinstance(units[0], dict) else {}
        source_id = str(unit.get("source_id", ""))
        refs = success.get("refs") if isinstance(success.get("refs"), dict) else {}
        return {
            "name": unit.get("strat_name") or unit.get("name"),
            "lithology": unit.get("lith"),
            "age": unit.get("best_int_name") or unit.get("age"),
            "description": unit.get("descrip") or unit.get("comments"),
            "color": unit.get("color"),
            "source_id": unit.get("source_id"),
            "source_reference": refs.get(source_id),
        }, None
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logging.getLogger(__name__).warning("site evidence request failed", exc_info=True)
        return None, "地质服务暂不可用，缺少地质证据"


@tool(response_format="content_and_artifact", args_schema=SiteEnvironmentInput)
async def inspect_site_environment(
    station_name_or_uuid: str,
    tool_call_id: str,
) -> tuple[str | ToolMessage, dict[str, Any]]:
    """查询监测点周边的场地环境背景。

    可获取站点空间分布、同组点位置、地形（海拔/坡度/坡向/高差）、
    地质单元及构造线等可用公开资料，适用于需要从场地环境角度补充调查背景的任务。
    场地环境属于辅助证据，并非每次监测数据分析都需要调用。

    Args:
        station_name_or_uuid: 监测点名称（需能唯一确定）或 36 位 UUID。
    """
    async with _build_client() as client:
        station = await _resolve_station(client, station_name_or_uuid)
        center = _station_to_dict(station)
        latitude = center.get("latitude")
        longitude = center.get("longitude")
        if latitude is None or longitude is None:
            message = "该监测点未登记有效的 WGS84 经纬度，无法生成场地环境地图"
            raise ToolFailure(message)
        group_stations = await client.get_stations(group_uuid=station.group_uuid)

    terrain_task = _fetch_terrain(latitude, longitude)
    geology_task = _fetch_geology(latitude, longitude)
    (terrain, terrain_error), (geology, geology_error) = await asyncio.gather(terrain_task, geology_task)
    stations = [_station_to_dict(item) for item in group_stations]
    map_stations = [item for item in stations if item.get("latitude") is not None and item.get("longitude") is not None]

    sources = [
        {
            "name": "北斗监测平台",
            "role": "站点与登记坐标",
            "coordinate_system": "WGS84",
        },
        {
            "name": "Open-Meteo / Copernicus DEM GLO-90",
            "role": "海拔、坡度、坡向与局部高差",
            "url": "https://open-meteo.com/en/docs/elevation-api",
        },
        {
            "name": "Macrostrat",
            "role": "地质单元与断层图层",
            "url": "https://macrostrat.org/",
            "license": "CC BY 4.0",
        },
    ]
    limitations = [message for message in (terrain_error, geology_error) if message]
    observed_at = business_now().isoformat(timespec="seconds")
    environment = {
        "version": 1,
        "observed_at": observed_at,
        "coordinate_system": "WGS84",
        "center_station": center,
        "group_stations": map_stations,
        "terrain": terrain,
        "geology": geology,
        "faults": {
            "available": True,
            "distance_km": None,
            "note": "断层以 Macrostrat 构造线图层展示；当前公开接口不提供可靠的最近断层距离。",
        },
        "layer_sources": {
            "geology_tiles": "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt",
            "geology_source_layer": "units",
            "fault_source_layer": "lines",
        },
    }
    content = {
        "ok": True,
        "station": center,
        "same_group_station_count": len(map_stations),
        "terrain": terrain,
        "geology": geology,
        "faults": environment["faults"],
        "limitations": limitations,
        "sources": sources,
    }
    if limitations:
        return tool_error_result(
            "场地环境资料不完整：" + "；".join(limitations),
            tool_call_id=tool_call_id,
            tool_name="inspect_site_environment",
            kind="site_environment",
            facts=content,
            data=environment,
            sources=sources,
            limitations=limitations,
            observed_at=observed_at,
        )
    return tool_result(
        content,
        kind="site_environment",
        display=environment,
        sources=sources,
        limitations=limitations,
        observed_at=observed_at,
    )
