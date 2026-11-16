import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuiEvent } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { STATUS_PRIORITY } from '@/features/monitoring/investigation';
import type { SessionConclusion } from '@/services/api';
import type { InvestigationStatus } from '@/types/envelope';

export interface SessionVerdict {
  /** 这次调查里最需要处理的那个结论。 */
  status: string;
  stations: string[];
}

const NO_CONCLUSIONS: readonly SessionConclusion[] = [];

const SessionConclusionsContext = createContext<ReadonlyMap<string, SessionVerdict>>(new Map());

const priorityOf = (status: string) => STATUS_PRIORITY[status as InvestigationStatus] ?? Number.MAX_SAFE_INTEGER;

function toVerdicts(conclusions: readonly SessionConclusion[]): Map<string, SessionVerdict> {
  const verdicts = new Map<string, SessionVerdict>();
  for (const conclusion of conclusions) {
    const verdict = verdicts.get(conclusion.session_id);
    if (!verdict) {
      verdicts.set(conclusion.session_id, { status: conclusion.status, stations: [conclusion.station_name] });
      continue;
    }
    verdict.stations.push(conclusion.station_name);
    if (priorityOf(conclusion.status) < priorityOf(verdict.status)) {
      verdict.status = conclusion.status;
    }
  }
  return verdicts;
}

/** 会话列表旁的结论标记。它只是补充信息：读取失败时保留上一次结果，不打断会话列表。 */
export function SessionConclusionsProvider({ children }: { children: ReactNode }) {
  const client = useLmaClient();
  const queryClient = useQueryClient();
  const { data: conclusions = NO_CONCLUSIONS } = useQuery({
    queryKey: ['session-conclusions'],
    queryFn: ({ signal }) => client.listSessionConclusions(signal),
  });

  // 一轮调查结束可能登记了新结论。
  useAuiEvent('thread.runEnd', () => {
    void queryClient.invalidateQueries({ queryKey: ['session-conclusions'] });
  });

  const verdicts = useMemo(() => toVerdicts(conclusions), [conclusions]);
  return <SessionConclusionsContext.Provider value={verdicts}>{children}</SessionConclusionsContext.Provider>;
}

export function useSessionVerdict(sessionId: string | undefined): SessionVerdict | undefined {
  const verdicts = useContext(SessionConclusionsContext);
  return sessionId ? verdicts.get(sessionId) : undefined;
}
