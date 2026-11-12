import { useEffect, useMemo, type ReactNode } from 'react';
import { AuiConfig, AuiProvider, useAuiEvent, useAuiState } from '@assistant-ui/react';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { StationInspector } from '@/features/monitoring/StationInspector';
import { StationInspectorProvider, useStationInspector } from '@/features/monitoring/StationInspectorContext';

function InvestigationEvents({ onComplete, onRunningChange, active }: {
  onComplete: () => void;
  onRunningChange: (running: boolean) => void;
  active: boolean;
}) {
  const { closeInspector } = useStationInspector();
  const sessionId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  useEffect(() => {
    // 返回仍在运行的测点调查时，地址也恢复到正在查看的会话。
    if (active && sessionId) {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('stationThread')) {
        url.searchParams.set('stationThread', sessionId);
        window.history.replaceState(null, '', url);
      }
    }
  }, [active, sessionId]);
  useEffect(() => {
    if (!active) {
      closeInspector();
    }
  }, [active, closeInspector]);
  useAuiEvent('thread.runStart', () => onRunningChange(true));
  useAuiEvent('thread.runEnd', () => {
    onComplete();
    onRunningChange(false);
  });
  return null;
}

/** 每次进入测点从空白调查开始；历史结果只从记录入口打开。浏览不创建数据库会话。 */
export function StationConversation({ stationUuid, stationName, onComplete, onRunningChange, active, children }: {
  stationUuid: string;
  stationName: string;
  onComplete: () => void;
  onRunningChange: (running: boolean) => void;
  active: boolean;
  children: ReactNode;
}) {
  const client = useLmaClient();
  const scope = useMemo(
    () => ({ stationUuid, stationName }),
    [stationUuid, stationName],
  );
  return (
    <AuiProvider extends={null} config={AuiConfig({})}>
      <AssistantProvider client={client} scope={scope}>
        <StationInspectorProvider canSplit={false}>
          <InvestigationEvents onComplete={onComplete} onRunningChange={onRunningChange} active={active} />
          {children}
          <StationInspector />
        </StationInspectorProvider>
      </AssistantProvider>
    </AuiProvider>
  );
}
