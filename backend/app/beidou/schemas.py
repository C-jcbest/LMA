"""北斗平台接口响应的 Pydantic 模型（字段别名对应上游 PascalCase 返回）。"""

from pydantic import BaseModel, ConfigDict, Field


class StationGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    group_uuid: str = Field(alias="StationGroupUUID")
    group_name: str = Field(alias="StationGroupName")
    station_count: int = Field(default=0, alias="StationCount")
    description: str = Field(default="", alias="StationGroupDesc")


class Station(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    group_uuid: str = Field(alias="StationGroupUUID")
    group_name: str = Field(alias="StationGroupName")
    station_uuid: str = Field(alias="StationUUID")
    device_uuid: str = Field(default="", alias="DeviceUUID")
    station_name: str = Field(alias="StationName")
    # 初始坐标（平台登记的北向/东向坐标与海拔，单位 m）：
    # 累计位移类分析以它为基准，缺失时由调用方回退为数据首点
    station_n0: str = Field(default="", alias="StationN0")
    station_e0: str = Field(default="", alias="StationE0")
    station_u0: str = Field(default="", alias="StationU0")
    station_type: int = Field(default=0, alias="StationType")
    station_status: int = Field(default=0, alias="StationStatus")
    location: str = Field(default="", alias="StationLocation")
    description: str = Field(default="", alias="StationDesc")
    latitude: str = Field(default="", alias="Latitude")
    longitude: str = Field(default="", alias="Longitude")
    altitude: str = Field(default="", alias="Altitude")


class GnssDataPoint(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data_time: str = Field(alias="DataTime")
    data_timestamp: int = Field(default=0, alias="DataTimestamp")
    n: str = Field(alias="PJKInfoN")
    e: str = Field(alias="PJKInfoE")
    u: str = Field(alias="PJKInfoU")
