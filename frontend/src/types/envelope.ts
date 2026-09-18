/**
 * LMA 工具产物版本化协议信封 (Version 1)
 */

export type ToolArtifactKind =
  | 'station_list'
  | 'gnss_series'
  | 'weather'
  | 'vision'
  | 'station_comparison'
  | 'site_environment'
  | 'monitoring_map'
  | 'evidence'
  | 'generic';

export interface EvidenceSource {
  provider?: string;
  name?: string;
  coordinate_system?: string;
  observed_at?: string;
  url?: string;
  [key: string]: any;
}

export interface ToolArtifactEnvelope<T = any> {
  version: 1;
  kind: ToolArtifactKind;
  status: 'success' | 'partial' | 'error';
  data?: T;
  observedAt?: string;
  sources?: EvidenceSource[];
  limitations?: string[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    category?: string;
  };
  // 保持向前兼容现有扩展字段（如 site_environment, chart_points, images 等）
  site_environment?: any;
  chart_points?: any[];
  images?: any[];
  [key: string]: any;
}
