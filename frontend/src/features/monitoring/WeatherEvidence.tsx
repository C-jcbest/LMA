import { useAuiState } from '@assistant-ui/react';
import type { ToolArtifactEnvelopeFor } from '@/types/envelope';
import { chartDay, chartMillis } from './chart-time';
import { useStationInspector } from './StationInspectorContext';
import { WeatherResultView } from './tools/WeatherResultView';

export function WeatherEvidence({ evidence, inInspector }: { evidence: ToolArtifactEnvelopeFor<'weather'>; inInspector?: boolean }) {
  const { attachAskTarget, isSplit, closeInspector, composerInputRef } = useStationInspector();
  const running = useAuiState((state) => state.thread.isRunning);
  const location = evidence.data.location;
  return <WeatherResultView data={evidence.data} askDisabled={running} onAsk={(date) => {
    attachAskTarget({
      ...chartDay(chartMillis(date)),
      kind: 'rainfall',
      evidenceId: evidence.evidence_id,
      stationUuid: location.station_uuid ?? undefined,
      stationName: location.station_name ?? [location.latitude, location.longitude].join(', '),
    });
    if (inInspector && !isSplit) {
      closeInspector({ focusComposer: true });
    } else {
      composerInputRef.current?.focus();
    }
  }} />;
}
