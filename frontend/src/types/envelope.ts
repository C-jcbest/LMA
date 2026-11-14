/** LMA 工具产物版本化协议信封（Version 1）。 */

export type ToolArtifactKind =
  | 'acquisition_failure'
  | 'conclusions'
  | 'computation'
  | 'station_list'
  | 'gnss_series'
  | 'station_overview'
  | 'weather'
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
  /** 沿水平主方向的分段速率；水平位移很小时 available 为 false。 */
  rate_sequence?: RateSequence | null;
  /** 前后分段（按方向）与同组共同时段对比。 */
  comparisons?: Record<string, unknown>;
  /** 取数时平台登记的测点位置；旧依据没有该字段。 */
  location?: {
    group_name?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    /** 同组其他测点，只作地图上的位置参照。 */
    group_stations?: Array<{
      station_uuid: string;
      station_name: string;
      station_type?: string | null;
      latitude?: number | null;
      longitude?: number | null;
    }>;
  } | null;
}

export interface RateSegment {
  begin_time: string;
  end_time: string;
  rate_mm_day: number | null;
  uncertainty_mm_day: number | null;
  count: number;
}

export interface RateSequence {
  available: boolean;
  azimuth_deg?: number;
  segment_days?: number;
  segments?: RateSegment[];
  pattern?: '逐段增大' | '逐段减小' | '未见逐段增减' | '样本不足';
  description?: string;
  note?: string;
}

export interface GroupComparisonArtifact {
  begin_time: string;
  end_time: string;
  stations: Array<{
    station_uuid: string;
    station_name: string;
    common_samples: number;
    net_change_mm: Record<'n' | 'e' | 'u', number | null>;
  }>;
  failures: Record<string, string>;
}

export interface RainfallTotalsArtifact {
  period: { start_date: string; end_date: string };
  last_7_days_mm: number | null;
  last_30_days_mm: number | null;
  max_daily: { date: string; value: number } | null;
  daily: { time: string[]; precipitation_sum: Array<number | null> };
  source: string;
}

/** 测点概览：同一测点的长期每日与近期小时两个窗口。 */
export interface StationOverviewArtifactData {
  station_uuid: string;
  station_name: string;
  windows: GnssArtifactData[];
  group?: GroupComparisonArtifact | null;
  rainfall?: RainfallTotalsArtifact | null;
}

export interface WeatherDailyArtifact {
  time: string[];
  precipitation_sum?: Array<number | null> | null;
  precipitation_hours?: Array<number | null> | null;
  precipitation_probability_max?: Array<number | null> | null;
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
  units?: { precipitation: 'mm' } | null;
  current?: {
    time?: string | null;
    condition?: string | null;
    precipitation?: number | null;
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
  history?: { daily: WeatherDailyArtifact; hourly?: { time: string[]; precipitation: Array<number | null> } | null } | null;
  forecast?: { daily: WeatherDailyArtifact } | null;
  source?: { provider: string } | null;
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
}

export type InvestigationStatus = '未见明显变化' | '持续关注' | '需人工复核' | '数据不足' | '暂无法分析';

export interface ConclusionStationArtifact {
  station_uuid: string;
  station_name: string;
  status: InvestigationStatus;
  reason: string;
  /** 建议的现场或业务动作。 */
  next_step?: string | null;
  begin_time: string;
  end_time: string;
  /** 服务端关联的本会话依据编号。 */
  evidence: string[];
  /** 判断头的关键数，由服务端从与结论窗口最接近的位移依据计算。 */
  key_figures?: {
    begin_time: string;
    end_time: string;
    window_horizontal_change_mm?: number | null;
    cumulative_horizontal_mm?: number | null;
    completeness?: number | null;
  } | null;
}

/** 本次调查没覆盖、用户可能想继续的问题；界面显示为一键继续的按钮。 */
export interface FollowUpArtifact {
  question: string;
  station_uuid?: string | null;
  begin_time?: string | null;
  end_time?: string | null;
}

export interface ConclusionsArtifactData {
  stations: ConclusionStationArtifact[];
  follow_ups?: FollowUpArtifact[];
}

export interface ComputationArtifactData {
  description: string;
  code: string;
  inputs: Array<{ evidence_id: string; description: string }>;
  result: unknown;
  truncated: boolean;
}

export interface ArtifactDataByKind {
  acquisition_failure: { station_uuid?: string; station_name: string; requested_station: string; begin_time?: string; end_time?: string; message: string };
  conclusions: ConclusionsArtifactData;
  computation: ComputationArtifactData;
  station_list: StationListArtifactData;
  gnss_series: GnssArtifactData;
  station_overview: StationOverviewArtifactData;
  weather: WeatherArtifactData;
  site_environment: SiteEnvironmentArtifactData;
}

export type ToolArtifactEnvelopeFor<K extends ToolArtifactKind> = {
  evidence_id?: string;
  version: 1;
  kind: K;
  status: ToolArtifactStatus;
  data: ArtifactDataByKind[K];
  observedAt?: string;
  /** 调查过程中这一步的一句发现，由服务端生成。 */
  summary?: string;
  sources?: EvidenceSource[];
  limitations?: string[];
  error?: ToolArtifactError;
};

export type ToolArtifactEnvelope = {
  [K in ToolArtifactKind]: ToolArtifactEnvelopeFor<K>;
}[ToolArtifactKind];
