/** LMA 工具产物版本化协议信封（Version 1）。 */

export type ToolArtifactKind =
  | 'acquisition_failure'
  | 'conclusions'
  | 'computation'
  | 'plan'
  | 'station_list'
  | 'gnss_series'
  | 'weather'
  | 'vision'
  | 'site_environment';

export type ToolArtifactStatus = 'success' | 'partial' | 'error';

export interface EvidenceSource {
  provider?: string | null;
  name?: string | null;
  role?: string | null;
  coordinate_system?: string | null;
  observed_at?: string | null;
  url?: string | null;
  license?: string | null;
}

export interface ToolArtifactError {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
}

export interface StationGroupArtifact {
  group_name: string;
  station_count: number;
  description?: string | null;
}

export interface StationArtifact {
  station_uuid?: string | null;
  station_name: string;
  group_name?: string | null;
  station_type?: string | null;
  station_status?: string | null;
  location?: string | null;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  coordinate_system: 'WGS84';
}

export interface StationListArtifactData {
  total: number;
  groups: StationGroupArtifact[];
  stations: StationArtifact[];
}

export interface GnssPointArtifact {
  time: string;
  n?: string | number | null;
  e?: string | number | null;
  u?: string | number | null;
}

export interface AxisSummaryArtifact {
  count: number;
  first?: number | null;
  last?: number | null;
  change?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface GapArtifact {
  from: string;
  to: string;
  missing_hours: number | null;
}

/** 单个方向在本窗口的数值特征（mm、mm/day），由服务端计算。 */
export type AxisFeature = Record<string, unknown>;

export interface GnssArtifactData {
  station_uuid: string;
  station_name: string;
  begin_time: string;
  end_time: string;
  timezone: string;
  acquired_at?: string | null;
  total_points: number;
  returned_points: number;
  downsampled: boolean;
  points: GnssPointArtifact[];
  summary: {
    n: AxisSummaryArtifact;
    e: AxisSummaryArtifact;
    u: AxisSummaryArtifact;
    gaps: GapArtifact[];
  };
  sampling?: {
    mode: 'sample_times' | 'hourly';
    sample_times?: string[] | null;
    points_limit: number;
  } | null;
  quality?: Record<string, unknown>;
  reference?: Record<string, unknown>;
  /** n/e/u/h/d 各方向特征；测点页序列没有特征时为空对象。 */
  features?: Record<string, AxisFeature>;
  /** 前后分段（按方向）与同组共同时段对比。 */
  comparisons?: Record<string, unknown>;
  /** 取数时平台登记的测点位置；旧依据没有该字段。 */
  location?: {
    group_name?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
}

export interface WeatherDailyArtifact {
  time: string[];
  precipitation_sum?: Array<number | null> | null;
  precipitation_hours?: Array<number | null> | null;
  precipitation_probability_max?: Array<number | null> | null;
  temperature_2m_max?: Array<number | null> | null;
  temperature_2m_min?: Array<number | null> | null;
  wind_speed_10m_max?: Array<number | null> | null;
  wind_gusts_10m_max?: Array<number | null> | null;
}

export interface WeatherArtifactData {
  ok: boolean;
  location: {
    station_uuid?: string | null;
    station_name?: string | null;
    latitude: number;
    longitude: number;
    timezone?: string | null;
  };
  query: {
    timezone: string;
    history_start_date: string;
    history_end_date: string;
    forecast_days: number;
    hourly?: boolean;
  };
  units?: {
    temperature: 'celsius';
    wind_speed: 'km/h';
    precipitation: 'mm';
  } | null;
  current?: {
    time?: string | null;
    temperature_2m?: number | null;
    apparent_temperature?: number | null;
    relative_humidity_2m?: number | null;
    condition?: string | null;
    precipitation?: number | null;
    wind_speed_10m?: number | null;
    wind_gusts_10m?: number | null;
  } | null;
  rain_summary?: {
    recent_24h_precipitation?: number | null;
    recent_24h_window: {
      start_time: string;
      end_time: string;
      available_hours: number;
      expected_hours: number;
      complete: boolean;
      precipitation?: number | null;
      note: string;
    };
    history_total_precipitation?: number | null;
    history_max_daily_precipitation?: { date: string; value: number } | null;
    forecast_total_precipitation?: number | null;
    forecast_max_daily_precipitation?: { date: string; value: number } | null;
    forecast_max_precipitation_probability?: number | null;
  } | null;
  wind_summary?: {
    current_wind_speed?: number | null;
    current_wind_gust?: number | null;
    history_max_wind_speed?: number | null;
    history_max_wind_gust?: number | null;
    forecast_max_wind_speed?: number | null;
    forecast_max_wind_gust?: number | null;
  } | null;
  history?: { daily: WeatherDailyArtifact; hourly?: { time: string[]; precipitation: Array<number | null> } | null } | null;
  forecast?: { daily: WeatherDailyArtifact } | null;
  source?: { provider: string } | null;
}

export interface ToolCallImageArtifact {
  name: string;
  title?: string | null;
  png_base64: string;
}

export interface ChartPointArtifact {
  t: string;
  n?: number | null;
  e?: number | null;
  u?: number | null;
}

export interface VisionCandidateArtifact {
  metric: string;
  start_at: string;
  end_at: string;
  description?: string | null;
}

export interface VisionObservationsArtifact {
  candidates?: VisionCandidateArtifact[];
  fact_text?: string | null;
  trends?: string[];
  turning_points?: string[];
  image_quality?: string | null;
}

export interface VisionArtifactData {
  station_uuid: string;
  station_name: string;
  begin_time: string;
  end_time: string;
  timezone: string;
  total_points: number;
  images: ToolCallImageArtifact[];
  chart_points: ChartPointArtifact[];
  ok?: boolean | null;
  observations?: VisionObservationsArtifact | null;
}

export interface SiteEnvironmentArtifactData {
  version: 1;
  observed_at: string;
  coordinate_system: 'WGS84';
  center_station: StationArtifact;
  group_stations: StationArtifact[];
  terrain?: {
    dem_elevation_m?: number | null;
    slope_degrees?: number | null;
    aspect_degrees?: number | null;
    aspect?: string | null;
    relief_500m_m?: number | null;
    resolution_m?: number | null;
  } | null;
  geology?: {
    name?: string | null;
    lithology?: string | null;
    age?: string | null;
    description?: string | null;
    color?: string | null;
    source_id?: string | number | null;
    source_reference?: string | null;
  } | null;
  faults: { available: boolean; distance_km?: number | null; note: string };
  layer_sources: {
    geology_tiles: string;
    geology_source_layer: string;
    fault_source_layer: string;
  };
}

export type InvestigationStatus = '未见明显变化' | '持续关注' | '需人工复核' | '数据不足' | '暂无法分析';

export interface ConclusionStationArtifact {
  station_uuid: string;
  station_name: string;
  status: InvestigationStatus;
  reason: string;
  begin_time: string;
  end_time: string;
  /** 服务端关联的本会话依据编号。 */
  evidence: string[];
}

export interface ConclusionsArtifactData {
  stations: ConclusionStationArtifact[];
}

export interface ComputationArtifactData {
  description: string;
  code: string;
  inputs: Array<{ evidence_id: string; description: string }>;
  result: unknown;
  truncated: boolean;
}

export interface PlanItemArtifact {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanArtifactData {
  items: PlanItemArtifact[];
}

export interface ArtifactDataByKind {
  acquisition_failure: { station_uuid?: string; station_name: string; requested_station: string; begin_time?: string; end_time?: string; message: string };
  conclusions: ConclusionsArtifactData;
  computation: ComputationArtifactData;
  plan: PlanArtifactData;
  station_list: StationListArtifactData;
  gnss_series: GnssArtifactData;
  weather: WeatherArtifactData;
  vision: VisionArtifactData;
  site_environment: SiteEnvironmentArtifactData;
}

export type ToolArtifactEnvelopeFor<K extends ToolArtifactKind> = {
  evidence_id?: string;
  version: 1;
  kind: K;
  status: ToolArtifactStatus;
  data: ArtifactDataByKind[K];
  observedAt?: string;
  sources?: EvidenceSource[];
  limitations?: string[];
  error?: ToolArtifactError;
};

export type ToolArtifactEnvelope = {
  [K in ToolArtifactKind]: ToolArtifactEnvelopeFor<K>;
}[ToolArtifactKind];
