"""客户端工具产物的版本化 Pydantic 契约。"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, model_validator


class ArtifactModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceSource(ArtifactModel):
    provider: str | None = None
    name: str | None = None
    role: str | None = None
    coordinate_system: str | None = None
    observed_at: str | None = None
    url: str | None = None
    license: str | None = None


class ToolArtifactError(ArtifactModel):
    code: str
    category: str
    message: str
    retryable: bool = False


class StationGroupArtifact(ArtifactModel):
    group_name: str
    station_count: int = 0
    description: str | None = None


class StationArtifact(ArtifactModel):
    station_uuid: str | None = None
    station_name: str
    group_name: str | None = None
    station_type: str | None = None
    station_status: str | None = None
    location: str | None = None
    description: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    altitude: float | None = None
    coordinate_system: Literal["WGS84"] = "WGS84"


class StationListArtifactData(ArtifactModel):
    total: int
    groups: list[StationGroupArtifact] = Field(default_factory=list)
    stations: list[StationArtifact] = Field(default_factory=list)


class GnssPointArtifact(ArtifactModel):
    time: str
    n: str | float | int | None = None
    e: str | float | int | None = None
    u: str | float | int | None = None


class AxisSummaryArtifact(ArtifactModel):
    count: int
    first: float | None = None
    last: float | None = None
    change: float | None = None
    min: float | None = None
    max: float | None = None


class GapArtifact(ArtifactModel):
    from_: str = Field(alias="from")
    to: str
    missing_hours: float | None
    missing_count: int | None = None
    boundary: str | None = None
    first_missing_time: str | None = None
    last_missing_time: str | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class GnssSummaryArtifact(ArtifactModel):
    n: AxisSummaryArtifact
    e: AxisSummaryArtifact
    u: AxisSummaryArtifact
    gaps: list[GapArtifact]


class GnssSamplingArtifact(ArtifactModel):
    mode: Literal["sample_times", "hourly"]
    sample_times: list[str] | None = None
    points_limit: int


class GroupStationArtifact(ArtifactModel):
    station_uuid: str
    station_name: str
    station_type: str | None = None
    latitude: float | None = None
    longitude: float | None = None


class GnssStationLocationArtifact(ArtifactModel):
    """取数时平台登记的测点位置，供界面在对话中绘制测点地图。"""

    group_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    coordinate_system: Literal["WGS84"] = "WGS84"
    # 同组其他测点只作地图上的位置参照，不是本次取得的位移依据。
    group_stations: list[GroupStationArtifact] = Field(default_factory=list)


class GnssArtifactData(ArtifactModel):
    """位移序列与同一窗口的数值特征；features/comparisons 的结构见 numerical.py。"""

    coordinate_unit: Literal["m"] = "m"
    summary_unit: Literal["m"] = "m"
    station_uuid: str
    station_name: str
    begin_time: str
    end_time: str
    timezone: str
    acquired_at: str | None = None
    total_points: int
    returned_points: int
    downsampled: bool
    points: list[GnssPointArtifact]
    summary: GnssSummaryArtifact
    sampling: GnssSamplingArtifact | None = None
    quality: dict[str, JsonValue] = Field(default_factory=dict)
    reference: dict[str, JsonValue] = Field(default_factory=dict)
    features: dict[str, JsonValue] = Field(default_factory=dict)
    rate_sequence: dict[str, JsonValue] | None = None
    comparisons: dict[str, JsonValue] = Field(default_factory=dict)
    raw_points: list[GnssPointArtifact] = Field(default_factory=list)
    location: GnssStationLocationArtifact | None = None


class WeatherLocationArtifact(ArtifactModel):
    station_uuid: str | None = None
    station_name: str | None = None
    latitude: float
    longitude: float
    timezone: str | None = None


class WeatherQueryArtifact(ArtifactModel):
    timezone: str
    history_start_date: str
    history_end_date: str
    forecast_days: int
    hourly: bool = False


class WeatherCurrentArtifact(ArtifactModel):
    time: str | None = None
    temperature_2m: float | None = None
    apparent_temperature: float | None = None
    relative_humidity_2m: float | None = None
    condition: str | None = None
    precipitation: float | None = None
    wind_speed_10m: float | None = None
    wind_gusts_10m: float | None = None


class WeatherWindowArtifact(ArtifactModel):
    start_time: str
    end_time: str
    available_hours: int
    expected_hours: int
    complete: bool
    precipitation: float | None = None
    note: str


class DailyMaximumArtifact(ArtifactModel):
    date: str
    value: float


class RainSummaryArtifact(ArtifactModel):
    recent_24h_precipitation: float | None = None
    recent_24h_window: WeatherWindowArtifact
    history_total_precipitation: float | None = None
    history_max_daily_precipitation: DailyMaximumArtifact | None = None
    forecast_total_precipitation: float | None = None
    forecast_max_daily_precipitation: DailyMaximumArtifact | None = None
    forecast_max_precipitation_probability: float | None = None


class WindSummaryArtifact(ArtifactModel):
    current_wind_speed: float | None = None
    current_wind_gust: float | None = None
    history_max_wind_speed: float | None = None
    history_max_wind_gust: float | None = None
    forecast_max_wind_speed: float | None = None
    forecast_max_wind_gust: float | None = None


class WeatherDailyArtifact(ArtifactModel):
    time: list[str]
    precipitation_sum: list[float | None] | None = None
    precipitation_hours: list[float | None] | None = None
    precipitation_probability_max: list[float | None] | None = None
    temperature_2m_max: list[float | None] | None = None
    temperature_2m_min: list[float | None] | None = None
    wind_speed_10m_max: list[float | None] | None = None
    wind_gusts_10m_max: list[float | None] | None = None


class WeatherHourlyArtifact(ArtifactModel):
    """小时降水量代表该时间戳之前一小时的总量。"""

    time: list[str]
    precipitation: list[float | None]


class WeatherSeriesArtifact(ArtifactModel):
    daily: WeatherDailyArtifact
    hourly: WeatherHourlyArtifact | None = None


class WeatherUnitsArtifact(ArtifactModel):
    temperature: Literal["celsius"]
    wind_speed: Literal["km/h"]
    precipitation: Literal["mm"]


class WeatherSourceArtifact(ArtifactModel):
    provider: str


class WeatherArtifactData(ArtifactModel):
    ok: bool
    location: WeatherLocationArtifact
    query: WeatherQueryArtifact
    units: WeatherUnitsArtifact | None = None
    current: WeatherCurrentArtifact | None = None
    rain_summary: RainSummaryArtifact | None = None
    wind_summary: WindSummaryArtifact | None = None
    history: WeatherSeriesArtifact | None = None
    forecast: WeatherSeriesArtifact | None = None
    source: WeatherSourceArtifact | None = None


class TerrainArtifact(ArtifactModel):
    dem_elevation_m: float | None = None
    slope_degrees: float | None = None
    aspect_degrees: float | None = None
    aspect: str | None = None
    relief_500m_m: float | None = None
    resolution_m: float | None = None


class GeologyArtifact(ArtifactModel):
    name: str | None = None
    lithology: str | None = None
    age: str | None = None
    description: str | None = None
    color: str | None = None
    source_id: str | int | None = None
    source_reference: str | None = None


class FaultArtifact(ArtifactModel):
    available: bool
    distance_km: float | None = None
    note: str


class LayerSourcesArtifact(ArtifactModel):
    geology_tiles: str
    geology_source_layer: str
    fault_source_layer: str


class SiteEnvironmentArtifactData(ArtifactModel):
    version: Literal[1]
    observed_at: str
    coordinate_system: Literal["WGS84"]
    center_station: StationArtifact
    group_stations: list[StationArtifact]
    terrain: TerrainArtifact | None = None
    geology: GeologyArtifact | None = None
    faults: FaultArtifact
    layer_sources: LayerSourcesArtifact


class AcquisitionFailureArtifactData(ArtifactModel):
    station_uuid: str | None = None
    station_name: str
    requested_station: str
    begin_time: str | None = None
    end_time: str | None = None
    message: str


InvestigationStatus = Literal["未见明显变化", "持续关注", "需人工复核", "数据不足", "暂无法分析"]


class ConclusionStationArtifact(ArtifactModel):
    station_uuid: str
    station_name: str
    status: InvestigationStatus
    reason: str
    begin_time: str
    end_time: str
    evidence: list[str] = Field(description="服务端关联的本会话依据编号")


class ConclusionsArtifactData(ArtifactModel):
    stations: list[ConclusionStationArtifact]


class ComputationInputArtifact(ArtifactModel):
    evidence_id: str
    description: str


class ComputationArtifactData(ArtifactModel):
    description: str
    code: str
    inputs: list[ComputationInputArtifact]
    result: JsonValue
    truncated: bool = False


ARTIFACT_DATA_MODELS: dict[str, type[ArtifactModel]] = {
    "acquisition_failure": AcquisitionFailureArtifactData,
    "conclusions": ConclusionsArtifactData,
    "computation": ComputationArtifactData,
    "station_list": StationListArtifactData,
    "gnss_series": GnssArtifactData,
    "weather": WeatherArtifactData,
    "site_environment": SiteEnvironmentArtifactData,
}


def validate_artifact_data(kind: str, data: dict) -> dict:
    """按 kind 校验并规范化客户端数据；未知 kind 不允许静默通过。"""
    model = ARTIFACT_DATA_MODELS.get(kind)
    if model is None:
        raise ValueError(f"unsupported tool artifact kind: {kind}")
    return model.model_validate(data).model_dump(mode="json", by_alias=True)


class ArtifactEnvelopeBase(ArtifactModel):
    version: Literal[1]
    status: Literal["success", "partial", "error"]
    sources: list[EvidenceSource] | None = None
    limitations: list[str] | None = None
    observedAt: str | None = None
    error: ToolArtifactError | None = None

    @model_validator(mode="after")
    def require_error_details_for_error_status(self):
        if self.status == "error" and self.error is None:
            raise ValueError("error artifact must include error details")
        if self.status != "error" and self.error is not None:
            raise ValueError("non-error artifact cannot include error details")
        return self


class StationListArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["station_list"]
    data: StationListArtifactData


class GnssArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["gnss_series"]
    data: GnssArtifactData


class WeatherArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["weather"]
    data: WeatherArtifactData


class SiteEnvironmentArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["site_environment"]
    data: SiteEnvironmentArtifactData


class ConclusionsArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["conclusions"]
    data: ConclusionsArtifactData


class ComputationArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["computation"]
    data: ComputationArtifactData


class AcquisitionFailureArtifactEnvelope(ArtifactEnvelopeBase):
    kind: Literal["acquisition_failure"]
    data: AcquisitionFailureArtifactData


ToolArtifactEnvelope = Annotated[
    AcquisitionFailureArtifactEnvelope
    | ConclusionsArtifactEnvelope
    | ComputationArtifactEnvelope
    | StationListArtifactEnvelope
    | GnssArtifactEnvelope
    | WeatherArtifactEnvelope
    | SiteEnvironmentArtifactEnvelope,
    Field(discriminator="kind"),
]

_ARTIFACT_ENVELOPE_ADAPTER = TypeAdapter(ToolArtifactEnvelope)


def validate_artifact_envelope(envelope: dict) -> dict:
    """执行最终 envelope 校验，返回可安全发送给客户端的 JSON 数据。"""
    return _ARTIFACT_ENVELOPE_ADAPTER.validate_python(envelope).model_dump(
        mode="json", exclude_none=True
    )
