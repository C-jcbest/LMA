import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuiEvent } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { STATUS_PRIORITY } from '@/features/monitoring/investigation';
import type { SessionConclusion } from '@/services/api';
import type { InvestigationStatus } from '@/types/envelope';

export interface SessionVerdict {
  status: string;
  stations: string[];
}

export type SessionStatusFilter = 'all' | '需人工复核' | '持续关注' | 'none';

export function matchesSessionStatusFilter(verdict: SessionVerdict | undefined, filter: SessionStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return !verdict;
  return verdict?.status === filter;
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

export function SessionConclusionsProvider({ children }: { children: ReactNode }) {
  const client = useLmaClient();
  const queryClient = useQueryClient();
  const { data: conclusions = NO_CONCLUSIONS } = useQuery({
    queryKey: ['session-conclusions'],
    queryFn: ({ signal }) => client.listSessionConclusions(signal),
  });

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

export function useSessionVerdicts(): ReadonlyMap<string, SessionVerdict> {
  return useContext(SessionConclusionsContext);
}
