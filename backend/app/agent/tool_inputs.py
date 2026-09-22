"""工具参数在 Pydantic schema 层校验，不访问数据源。"""
import re
from datetime import datetime, date
from typing import Annotated, Literal
from langchain_core.tools import InjectedToolCallId
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from app.business_time import TIME_FORMAT
_TIME_FORMAT = TIME_FORMAT
_MAX_SAMPLE_TIMES = 6

def _validate_time(value: str) -> str:
    datetime.strptime(value, _TIME_FORMAT)
    return value


def _parse_frequency_minutes(value: str) -> int | None:
    """把采样频率解析为分钟数：支持 "1h"/"2h"、"every 6 hours"、整数分钟（"90" 或 "90m"）。"""
    if not value:
        return None
    text = value.strip().lower()
    match = re.match(r"^(?:every\s+)?(\d+(?:\.\d+)?)\s*h(?:our)?s?$", text)
    if match:
        return int(float(match.group(1)) * 60)
    match = re.match(r"^(\d+)\s*(?:m(?:in(?:ute)?s?)?)?$", text)
    if match:
        return int(match.group(1))
    return None


def _normalize_sample_times(values: list[str]) -> list[str] | str:
    """校验并规范化固定每日取样时刻，返回按时刻排序的去重列表；非法时返回错误说明。

    日监测数据源为小时级，非整点时刻匹配不到任何数据，必须校验为整点。
    """
    seen: set[str] = set()
    for raw in values:
        text = str(raw).strip()
        if text.lower().startswith("daily "):
            text = text[6:].strip()
        parsed = None
        for fmt in ("%H:%M:%S", "%H:%M"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        if parsed is None:
            return f"固定取样时刻“{raw}”格式无效，应为 HH:mm 或 HH:mm:ss（如 15:00）"
        if parsed.minute != 0 or parsed.second != 0:
            return (
                f"固定取样时刻“{text}”不是整点：日监测数据源为小时级，"
                "非整点时刻匹配不到数据，请使用整点时刻（如 15:00）"
            )
        seen.add(parsed.strftime("%H:%M"))
    if not seen:
        return "sample_times 不能为空"
    if len(seen) > _MAX_SAMPLE_TIMES:
        return f"固定取样时刻最多 {_MAX_SAMPLE_TIMES} 个（当前 {len(seen)} 个），请减少后重试"
    return sorted(seen)


class ToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StationInput(ToolInput):
    station_name_or_uuid: str = Field(min_length=1, max_length=200, description="监测点名称或 UUID，需能唯一确定")


class TimeWindowInput(StationInput):
    begin_time: str = Field(description="开始时间，Asia/Shanghai，YYYY-MM-DD HH:mm:ss")
    end_time: str = Field(description="结束时间，Asia/Shanghai，YYYY-MM-DD HH:mm:ss，必须晚于开始时间")

    @field_validator("begin_time", "end_time")
    @classmethod
    def valid_time(cls, value):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", value):
            raise ValueError("时间必须为 YYYY-MM-DD HH:mm:ss")
        return _validate_time(value)

    @model_validator(mode="after")
    def ordered_window(self):
        if self.begin_time >= self.end_time:
            raise ValueError("开始时间必须早于结束时间")
        return self


class SiteEnvironmentInput(StationInput):
    tool_call_id: Annotated[str, InjectedToolCallId]


class VisionInput(TimeWindowInput):
    tool_call_id: Annotated[str, InjectedToolCallId]


class GnssInput(TimeWindowInput):
    sampling_frequency: str | None = Field(default=None, description="小时或整数分钟，例如 1h、6h、90m")
    sample_times: list[str] | None = Field(default=None, description="每日整点取样时刻，最多6个，例如 [03:00, 15:00]；优先于频率")

    @field_validator("sampling_frequency")
    @classmethod
    def valid_frequency(cls, value):
        if value is not None and not _parse_frequency_minutes(value):
            raise ValueError("采样频率无法识别，请使用小时或整数分钟")
        return value

    @field_validator("sample_times")
    @classmethod
    def valid_samples(cls, value):
        if value is None:
            return value
        normalized = _normalize_sample_times(value)
        if isinstance(normalized, str):
            raise ValueError(normalized)
        return normalized


class StationListInput(ToolInput):
    group_name: str | None = None
    station_name: str | None = None
    station_status: Literal[10, 20, 30, 40] | None = Field(default=None, description="10正常、20离线、30告警、40故障")


class WeatherInput(ToolInput):
    station_name_or_uuid: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="监测点名称（模糊匹配，需能唯一确定）或 36 位 UUID。提供后自动解析站点经纬度，与经纬度二选一",
    )
    latitude: float | None = Field(
        default=None,
        ge=-90,
        le=90,
        allow_inf_nan=False,
        description="纬度（-90 到 90）。与 longitude 成对提供，与 station_name_or_uuid 二选一",
    )
    longitude: float | None = Field(
        default=None,
        ge=-180,
        le=180,
        allow_inf_nan=False,
        description="经度（-180 到 180）。与 latitude 成对提供，与 station_name_or_uuid 二选一",
    )
    start_date: str | None = Field(
        default=None,
        description="历史天气开始日期，Asia/Shanghai，格式 YYYY-MM-DD，最早支持 1940-01-01。与 end_date 成对提供（不传默认查询最近 7 天，最多到昨天），单次历史跨度不超过 31 天。",
    )
    end_date: str | None = Field(
        default=None,
        description="历史天气结束日期，格式 YYYY-MM-DD，最多只能查询到昨天。与 start_date 成对提供，单次跨度不超过 31 天。",
    )
    forecast_days: int = Field(
        default=7,
        ge=0,
        le=16,
        strict=True,
        description="未来预报天数，取值范围 0 到 16 天（0 表示不查询预报），默认 7 天。",
    )

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
            if self.start_date > self.end_date:
                raise ValueError("开始日期不能晚于结束日期")
            s_date = date.fromisoformat(self.start_date)
            e_date = date.fromisoformat(self.end_date)
            if s_date < date(1940, 1, 1):
                raise ValueError("历史天气最早支持查询至 1940-01-01")
            if (e_date - s_date).days + 1 > 31:
                raise ValueError("历史天气查询跨度不能超过 31 天")
        return self
