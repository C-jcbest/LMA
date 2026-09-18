import React from 'react';
import type { ToolArtifactEnvelope, ToolArtifactKind } from '../types/envelope';
import { GnssResultView } from '../features/monitoring/GnssResultView';
import { WeatherResultView } from '../features/monitoring/WeatherResultView';
import { StationResultView } from '../features/monitoring/StationResultView';
import { VisionResultView } from '../features/monitoring/VisionResultView';
import { SiteEnvironmentView } from '../features/monitoring/SiteEnvironmentView';
import { EmptyOrGenericResultView } from '../features/monitoring/EmptyOrGenericResultView';

export interface MonitoringRendererProps {
  envelope: ToolArtifactEnvelope;
}

export const MONITORING_RENDERERS: Record<
  ToolArtifactKind,
  React.ComponentType<MonitoringRendererProps>
> = {
  gnss_series: ({ envelope }) => <GnssResultView data={envelope.data} />,
  weather: ({ envelope }) => <WeatherResultView data={envelope.data} />,
  station_list: ({ envelope }) => <StationResultView data={envelope.data} />,
  vision: ({ envelope }) => (
    <VisionResultView
      data={envelope.data}
      artifactImages={envelope.images}
    />
  ),
  site_environment: ({ envelope }) => {
    const env = envelope.site_environment || envelope.data?.site_environment || envelope.data;
    if (!env || !env.center_station) return <EmptyOrGenericResultView />;
    return <SiteEnvironmentView environment={env} />;
  },
  station_comparison: ({ envelope }) => <StationResultView data={envelope.data} />,
  monitoring_map: ({ envelope }) => {
    const env = envelope.site_environment || envelope.data;
    return env ? <SiteEnvironmentView environment={env} /> : <EmptyOrGenericResultView />;
  },
  evidence: ({ envelope }) => <EmptyOrGenericResultView />,
  generic: () => <EmptyOrGenericResultView />,
};

export function getMonitoringRenderer(kind: ToolArtifactKind): React.ComponentType<MonitoringRendererProps> {
  return MONITORING_RENDERERS[kind] || EmptyOrGenericResultView;
}
