"""工具参数在 Pydantic schema 层校验，不访问数据源。"""
import re
from datetime import date, datetime
from typing import Annotated, Literal

from langchain_core.tools import InjectedToolCallId
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.business_time import TIME_FORMAT

_MAX_SAMPLE_TIMES = 6
_MAX_WEATHER_DAYS = 366
_TIME_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")


def _business_time(value: str) -> str:
    if not _TIME_PATTERN.fullmatch(value):
        raise ValueError("时间必须为 YYYY-MM-DD HH:mm:ss")
    datetime.strptime(value, TIME_FORMAT)
    return value


def normalize_sample_times(values: list[str]) -> list[str]:
    """日监测数据源为小时级，固定取样时刻必须是整点，否则匹配不到数据。"""
    normalized: set[str] = set()
    for raw in values:
        text = str(raw).strip()
        if text.lower().startswith("daily "):
            text = text[6:].strip()
        parsed = None
        for pattern in ("%H:%M:%S", "%H:%M"):
            try:
                parsed = datetime.strptime(text, pattern)
                break
            except ValueError:
                continue
        if parsed is None:
            raise ValueError(f"固定取样时刻“{raw}”格式无效，应为 HH:mm（如 15:00）")
        if parsed.minute != 0 or parsed.second != 0:
            raise ValueError(f"固定取样时刻“{text}”不是整点；数据源为小时级，请使用整点")
        normalized.add(parsed.strftime("%H:%M"))
    if not normalized:
        raise ValueError("sample_times 不能为空")
    if len(normalized) > _MAX_SAMPLE_TIMES:
        raise ValueError(f"固定取样时刻最多 {_MAX_SAMPLE_TIMES} 个")
    return sorted(normalized)


class ToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StationInput(ToolInput):
    station_name_or_uuid: str = Field(min_length=1, max_length=200, description="监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID")


class TimeWindowInput(StationInput):
    begin_time: str = Field(description="开始时间，Asia/Shanghai，YYYY-MM-DD HH:mm:ss")
    end_time: str = Field(description="结束时间，Asia/Shanghai，YYYY-MM-DD HH:mm:ss，必须晚于开始时间")

    @field_validator("begin_time", "end_time")
    @classmethod
    def valid_time(cls, value):
        return _business_time(value)

    @model_validator(mode="after")
    def ordered_window(self):
        if self.begin_time >= self.end_time:
            raise ValueError("开始时间必须早于结束时间")
        return self


class FindStationsInput(ToolInput):
    group_name: str | None = Field(default=None, description="分组名称，模糊匹配，需能唯一确定一个分组")
    station_name: str | None = Field(default=None, description="监测点名称，模糊匹配")
    station_status: Literal["正常", "离线", "告警", "故障"] | None = None


class DisplacementInput(TimeWindowInput):
    sampling: Literal["hourly", "daily"] = Field(
        default="hourly",
        description="hourly 为小时数据，单次最多 366 天；daily 为每日固定时刻（默认 15:00），单次最多约 10 年，适合长期趋势",
    )
    sample_times: list[str] | None = Field(default=None, description="daily 采样的每日整点时刻，例如 [\"03:00\", \"15:00\"]；不传为 15:00")
    split_time: str | None = Field(default=None, description="可选：把窗口分成前后两段比较速率；前段不含分界，后段含分界")
    compare_stations: list[str] = Field(
        default_factory=list, max_length=8,
        description="可选：同组移动站名称或 UUID；只用所有站共同有效的观测时刻计算对比",
    )
    include_points: bool | None = Field(
        default=None,
        description="是否把逐点数据放进结果。不传时点数较少会自动返回；需要逐条查看时传 true（最多 1000 点）",
    )

    @field_validator("sample_times")
    @classmethod
    def valid_sample_times(cls, value):
        return None if value is None else normalize_sample_times(value)

    @field_validator("split_time")
    @classmethod
    def valid_split(cls, value):
        return None if value is None else _business_time(value)

    @model_validator(mode="after")
    def split_inside_window(self):
        if self.split_time and not self.begin_time < self.split_time < self.end_time:
            raise ValueError("split_time 必须在窗口内部")
        if self.sample_times and self.sampling != "daily":
            raise ValueError("sample_times 只用于 daily 采样")
        return self


class ChartInput(TimeWindowInput):
    tool_call_id: Annotated[str, InjectedToolCallId]


class SiteEnvironmentInput(StationInput):
    tool_call_id: Annotated[str, InjectedToolCallId]


class WeatherInput(ToolInput):
    station_name_or_uuid: str | None = Field(
        default=None, min_length=1, max_length=200,
        description="监测点名称或 UUID，自动使用其经纬度；与经纬度二选一",
    )
    latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    start_date: str | None = Field(
        default=None,
        description="历史开始日期 YYYY-MM-DD，与 end_date 成对提供；不传时为最近 7 天。历史最多到昨天，单次最多 366 天",
    )
    end_date: str | None = Field(default=None, description="历史结束日期 YYYY-MM-DD，最多到昨天")
    hourly: bool = Field(default=False, description="需要逐小时降水（例如某天几点下雨）时传 true；跨度较长时只看逐日即可")
    forecast_days: int = Field(default=0, ge=0, le=16, strict=True, description="未来预报天数，0 表示不查预报；当前天气总会返回")

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("日期必须为 YYYY-MM-DD")
            date.fromisoformat(value)
        return value

    @model_validator(mode="after")
    def paired_inputs(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("经纬度必须同时提供")
        if self.station_name_or_uuid is None and self.latitude is None:
            raise ValueError("请提供监测点或经纬度")
        if self.station_name_or_uuid is not None and self.latitude is not None:
            raise ValueError("监测点和经纬度只能选择一种定位方式")
        if (self.start_date is None) != (self.end_date is None):
            raise ValueError("历史起止日期必须同时提供")
        if self.start_date is not None and self.end_date is not None:
            start = date.fromisoformat(self.start_date)
            end = date.fromisoformat(self.end_date)
            if start > end:
                raise ValueError("开始日期不能晚于结束日期")
            if start < date(1940, 1, 1):
                raise ValueError("历史天气最早支持 1940-01-01")
            if (end - start).days + 1 > _MAX_WEATHER_DAYS:
                raise ValueError(f"历史天气单次最多 {_MAX_WEATHER_DAYS} 天，请分段查询")
        return self
