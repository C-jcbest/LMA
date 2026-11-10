"""不依赖视觉模型的数值调查入口。"""
import asyncio
from datetime import datetime, timedelta
from typing import Literal

from langchain_core.tools import tool
from pydantic import Field, model_validator

from app.agent.numerical import window_features, compare_windows, common_period_features, numerical_model_data
from app.agent.tools import _build_client, _resolve_station
from app.agent.tool_inputs import TimeWindowInput
from app.agent.tool_protocol import tool_result, ToolFailure
from app.business_time import TIME_FORMAT, business_now
from app.observations import normalize_observations, observation_quality, raw_snapshot, station_reference


class NumericalInput(TimeWindowInput):
    sampling: Literal["hourly", "daily"] = Field(
        default="hourly", description="hourly用于近期细节；daily按每日15:00取样用于长期背景",
    )
    compare_station_uuids: list[str] = Field(
        default_factory=list, max_length=8, description="同组比较对象UUID；仅用所有对象共同有效时间计算",
    )
    split_time: str | None = Field(default=None, description="可选两窗口分界；前窗不含分界，后窗含分界")

    @model_validator(mode="after")
    def validate_window(self):
        start = datetime.strptime(self.begin_time, TIME_FORMAT)
        end = datetime.strptime(self.end_time, TIME_FORMAT)
        max_days = 62 if self.sampling == "hourly" else 365
        if end - start > timedelta(days=max_days):
            raise ValueError(f"{self.sampling}数值回查单次不超过{max_days}天，请分窗或选择每日采样")
        if self.split_time:
            split = datetime.strptime(self.split_time, TIME_FORMAT)
            if not start < split < end:
                raise ValueError("分界必须在窗口内部")
        return self


@tool(args_schema=NumericalInput, response_format="content_and_artifact")
async def analyze_gnss_numerically(
    station_name_or_uuid: str,
    begin_time: str,
    end_time: str,
    split_time: str | None = None,
    compare_station_uuids: list[str] | None = None,
    sampling: str = "hourly",
):
    """独立数值复核：趋势净变化、最大候选跳变和保持情况，可比较两个窗口速度及同组共同有效时段。

    小时采样用于近期变化，每日15:00采样用于长期背景；无需图像或视觉模型，按问题自主选择。
    返回实际覆盖、方法和限制；不存在的观测不插值，不把倍率直接认定为加速。
    """
    cadence_hours = 24.0 if sampling == "daily" else 1.0
    sample_times = ["15:00"] if sampling == "daily" else None
    comparison_points = {}
    station_names = {}
    station_objects = {}
    raw_points = {}
    quality = {}
    async with _build_client() as client:
        station = await _resolve_station(client, station_name_or_uuid)
        if station.station_type == 1:
            return "基准站不适用移动站形变分析。", None
        requested = [station.station_uuid, *dict.fromkeys(compare_station_uuids or [])]
        for station_uuid in dict.fromkeys(requested):
            other = station
            if station_uuid != station.station_uuid:
                other = await _resolve_station(client, station_uuid)
                if not station.group_uuid or other.group_uuid != station.group_uuid or other.station_type == 1:
                    raise ToolFailure("共同有效时段比较只接受已确认同组的移动站")
            station_objects[other.station_uuid] = other
            station_names[other.station_uuid] = other.station_name
        limiter = asyncio.Semaphore(4)

        async def fetch(other):
            async with limiter:
                samples = await client.get_daily_data(
                    station_uuid=other.station_uuid, begin_time=begin_time, end_time=end_time,
                    sample_times=sample_times,
                )
            if len(samples) > 1600:
                raise ToolFailure("回查返回超过1600点，请缩小窗口或改用每日采样；未裁剪数据")
            points_in_window, cleaning = normalize_observations(samples, begin_time, end_time)
            comparison_points[other.station_uuid] = points_in_window
            raw_points[other.station_uuid] = raw_snapshot(samples)
            quality[other.station_uuid] = observation_quality(
                points_in_window, begin_time, end_time, sample_times=sample_times, cleaning=cleaning,
            )

        outcomes = await asyncio.gather(*(fetch(other) for other in station_objects.values()), return_exceptions=True)
        failures = {}
        for other, outcome in zip(station_objects.values(), outcomes):
            if isinstance(outcome, BaseException):
                if other.station_uuid == station.station_uuid:
                    raise outcome
                failures[other.station_uuid] = "该比较站未取得可用数据，不能用其他站代替"
                comparison_points[other.station_uuid] = []

    points = comparison_points[station.station_uuid]
    times = [point.data_time for point in points]
    features = window_features(points, station, begin_time, end_time, cadence_hours)
    comparisons = {}
    first = [point for point in points if split_time and point.data_time < split_time]
    second = [point for point in points if split_time and point.data_time >= split_time]
    if split_time:
        first_features = window_features(first, station, begin_time, split_time, cadence_hours, "first_window")
        second_features = window_features(second, station, split_time, end_time, cadence_hours, "second_window")
        for axis in features:
            comparisons[axis] = compare_windows(
                first_features[axis], second_features[axis],
            )
    if compare_station_uuids:
        comparisons["common_period"] = {
            axis: common_period_features(comparison_points, axis, cadence_hours=cadence_hours)
            for axis in ("n", "e", "u")
        }
        comparisons["station_names"] = station_names
        comparisons["failures"] = failures

    data = {
        "station_uuid": station.station_uuid, "station_name": station.station_name,
        "begin_time": begin_time, "end_time": end_time, "features": features,
        "comparisons": comparisons, "sampling": sampling,
        "quality": quality[station.station_uuid],
        "reference": {"coordinates_m": station_reference(station), "device_uuid": station.device_uuid,
                      "applicability": "获取时平台登记的固定参考；平台未提供变更历史，不能据此认定跨基准或迁站前后可直接拼接"},
        "raw_points": raw_points[station.station_uuid],
        "points": [dict(time=point.data_time, n=point.n, e=point.e, u=point.u) for point in points],
    }
    if compare_station_uuids:
        data["comparisons"]["snapshots"] = {
            identifier: [dict(time=point.data_time, n=point.n, e=point.e, u=point.u) for point in samples]
            for identifier, samples in comparison_points.items()
        }
        data["comparisons"]["quality"] = quality
    # 原始快照留作复核；模型只需计算结果，避免多站完整序列占满上下文。
    facts = {key: value for key, value in data.items() if key not in {"points", "raw_points", "comparisons"}}
    facts["comparisons"] = {key: value for key, value in comparisons.items() if key != "snapshots"}
    return tool_result(
        numerical_model_data(data), kind="numerical", display=data, observed_at=business_now().isoformat(),
        limitations=["仅描述数值证据；阈值未经真实场景校准，不构成灾害判断"],
    )
