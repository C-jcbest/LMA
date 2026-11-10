import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuiConfig, AuiProvider, useAuiEvent } from '@assistant-ui/react';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Skeleton } from '@/components/ui/skeleton';
import { StationInspector } from '@/features/monitoring/StationInspector';
import { StationInspectorProvider, useStationInspector } from '@/features/monitoring/StationInspectorContext';

function InvestigationEvents({ onComplete, onRunningChange, active }: {
  onComplete: () => void;
  onRunningChange: (running: boolean) => void;
  active: boolean;
}) {
  const { closeInspector } = useStationInspector();
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

/** 每个测点有自己的会话运行时，不使用全局最近选中的对话。浏览不创建数据库会话。 */
export function StationConversation({ stationUuid, stationName, onComplete, onRunningChange, active, children }: {
  stationUuid: string;
  stationName: string;
  onComplete: () => void;
  onRunningChange: (running: boolean) => void;
  active: boolean;
  children: (notice?: ReactNode) => ReactNode;
}) {
  const client = useLmaClient();
  const [sessionId, setSessionId] = useState<string | null>();
  const [hasError, setHasError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let acceptResult = true;
    setHasError(false);
    client.listSessions({ limit: 1, offset: 0, stationUuid }).then((sessions) => {
      if (acceptResult) {
        setSessionId(sessions[0]?.id ?? null);
      }
    }, () => {
      if (acceptResult) {
        setHasError(true);
      }
    });
    return () => {
      acceptResult = false;
    };
  }, [client, stationUuid, attempt]);
  const scope = useMemo(
    () => ({ stationUuid, stationName, initialThreadId: sessionId ?? undefined }),
    [stationUuid, stationName, sessionId],
  );
  if (hasError || sessionId === undefined) {
    return children(
      <div className="p-4">
        {hasError ? (
          <p role="alert" className="mt-4 text-sm text-muted-foreground">
            调查记录尚未载入。
            <button className="ms-2 underline" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          </p>
        ) : <Skeleton className="mt-4 h-64" />}
      </div>
    );
  }
  return (
    <AuiProvider extends={null} config={AuiConfig({})}>
      <AssistantProvider client={client} scope={scope}>
        <StationInspectorProvider canSplit={false}>
          <InvestigationEvents onComplete={onComplete} onRunningChange={onRunningChange} active={active} />
          {children()}
          <StationInspector />
        </StationInspectorProvider>
      </AssistantProvider>
    </AuiProvider>
  );
}
