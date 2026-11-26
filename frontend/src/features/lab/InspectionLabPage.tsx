import { useContext, useEffect, useRef, useState, type FC } from 'react';
import { AuiConfig, AuiProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon, SquareIcon } from 'lucide-react';
import { LmaClientContext } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useInspection } from '@/features/inspection/InspectionContext';
import type { LabInspection, LabScope, LabScopeGroup } from '@/services/api';
import { cn } from 'cn';
import { InspectionSummaryPart, ROW_COMPONENT, StationRowPart, SUMMARY_COMPONENT } from './LabParts';
import { labRunConfig, LabRuntimeProvider, useOpenLabInspection } from './LabRuntimeProvider';

type ScopeKind = LabScope['kind'];

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'group', label: '按组' },
  { value: 'station', label: '单站' },
] as const;

const STATUS_LABEL: Record<LabInspection['status'], string> = {
  idle: '未开始',
  running: '进行中',
  success: '完成',
  error: '未完成',
  cancelled: '已停止',
  interrupted: '已中断',
};

const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value));

const LabAssistantMessage: FC = () => (
  <MessagePrimitive.Root className="flex flex-col">
    <MessagePrimitive.Parts
      components={{
        Text: () => null,
        data: { by_name: { [SUMMARY_COMPONENT]: InspectionSummaryPart, [ROW_COMPONENT]: StationRowPart } },
      }}
    />
  </MessagePrimitive.Root>
);

const LabUserMessage: FC = () => null;

interface ScopePickerProps {
  groups: readonly LabScopeGroup[];
  onStart: (scope: LabScope, label: string) => void;
  onStop?: () => void;
  isRunning: boolean;
  isStopping: boolean;
  disabled: boolean;
}

const ScopePicker: FC<ScopePickerProps> = ({ groups, onStart, onStop, isRunning, isStopping, disabled }) => {
  const [kind, setKind] = useState<ScopeKind>('all');
  const [groupUuid, setGroupUuid] = useState('');
  const [stationUuid, setStationUuid] = useState('');
  const stations = groups.flatMap((group) => group.stations.map((station) => ({ ...station, groupName: group.group_name })));

  const effectiveGroupUuid = groupUuid || groups[0]?.group_uuid || '';
  const effectiveStationUuid = stationUuid || stations[0]?.station_uuid || '';

  let scope: LabScope | null = { kind: 'all' };
  let label = '全部测点';
  if (kind === 'group') {
    const group = groups.find((item) => item.group_uuid === effectiveGroupUuid);
    scope = group ? { kind: 'group', group_uuid: group.group_uuid } : null;
    label = group ? `${group.group_name} 分组` : '';
  } else if (kind === 'station') {
    const station = stations.find((item) => item.station_uuid === effectiveStationUuid);
    scope = station ? { kind: 'station', station_uuid: station.station_uuid } : null;
    label = station ? station.station_name : '';
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented label="巡检范围" value={kind} options={SCOPE_OPTIONS} onValueChange={(value) => setKind(value as ScopeKind)} />
      {kind === 'group' && (
        <Select value={effectiveGroupUuid} onValueChange={setGroupUuid}>
          <SelectTrigger size="sm" aria-label="选择分组" className="min-w-44"><SelectValue placeholder="选择分组" /></SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectItem key={group.group_uuid} value={group.group_uuid}>{group.group_name}（{group.stations.length}）</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {kind === 'station' && (
        <Select value={effectiveStationUuid} onValueChange={setStationUuid}>
          <SelectTrigger size="sm" aria-label="选择测点" className="min-w-52"><SelectValue placeholder="选择测点" /></SelectTrigger>
          <SelectContent>
            {stations.map((station) => (
              <SelectItem key={station.station_uuid} value={station.station_uuid}>
                {station.station_name}<span className="text-muted-foreground"> · {station.groupName}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {isRunning && onStop ? (
        <Button type="button" variant="outline" size="sm" disabled={isStopping} onClick={onStop}>
          <SquareIcon className="size-3 fill-current" aria-hidden />
          {isStopping ? '正在停止…' : '停止巡检'}
        </Button>
      ) : (
        <Button type="button" size="sm" disabled={disabled || scope === null} onClick={() => scope && onStart(scope, label)}>
          <PlayIcon className="size-3.5" aria-hidden />
          开始巡检
        </Button>
      )}
    </div>
  );
};

const ScopedInspectionBody: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const client = useContext(LmaClientContext)!;
  const queryClient = useQueryClient();
  const aui = useAui();
  const { reload: reloadInspection } = useInspection();
  const currentId = useAuiState((state) =>
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const openInspection = useOpenLabInspection();
  const [pendingStart, setPendingStart] = useState<{ id: string; scope: LabScope; label: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const wasRunningRef = useRef(false);

  const scopes = useQuery({
    queryKey: ['lab-scopes'],
    queryFn: ({ signal }) => client.listLabScopes(signal),
    staleTime: 5 * 60_000,
  });
  const history = useQuery({
    queryKey: ['lab-inspections'],
    queryFn: ({ signal }) => client.listLabInspections(signal),
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['lab-inspections'] });
    if (wasRunningRef.current && !isRunning) {
      reloadInspection();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, queryClient, reloadInspection]);

  const start = async (scope: LabScope, label: string) => {
    setStartError(null);
    try {
      const created = await client.createLabInspection();
      void queryClient.invalidateQueries({ queryKey: ['lab-inspections'] });
      setPendingStart({ id: created.id, scope, label });
      openInspection(created.id);
    } catch {
      setPendingStart(null);
      setStartError('巡检未能启动，请稍后重试。');
    }
  };

  const stop = async () => {
    if (!currentId) return;
    setIsStopping(true);
    try {
      await client.cancelLabRun(currentId);
      aui.thread().cancelRun();
      void queryClient.invalidateQueries({ queryKey: ['lab-inspections'] });
      reloadInspection();
    } catch {
      setStartError('停止请求未送达，请稍后重试。');
    } finally {
      setIsStopping(false);
    }
  };

  useEffect(() => {
    if (!pendingStart || isLoading || currentId !== pendingStart.id) {
      return;
    }
    setPendingStart(null);
    aui.thread().append({
      role: 'user',
      content: [{ type: 'text', text: `巡检范围：${pendingStart.label}` }],
      runConfig: labRunConfig(pendingStart.scope),
    });
  }, [aui, currentId, isLoading, pendingStart]);

  return (
    <div className={cn('@container mx-auto w-full max-w-208', compact ? 'px-5 pb-8 pt-2 sm:px-6' : 'px-4 pt-6 pb-10 sm:px-6 sm:pt-8')}>
      {!compact && (
        <div className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight">按范围巡检</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">按全部、分组或单站执行初筛与曲线初判，完成后同步更新今日概览与测点列表。</p>
        </div>
      )}

      <div>
        {scopes.isError && <p role="alert" className="text-sm text-muted-foreground">测点列表尚未载入。</p>}
        <ScopePicker
          groups={scopes.data ?? []}
          onStart={(scope, label) => void start(scope, label)}
          onStop={() => void stop()}
          isRunning={isRunning}
          isStopping={isStopping}
          disabled={isRunning || pendingStart !== null || !scopes.data}
        />
        {startError && <p role="alert" className="mt-2 text-sm text-destructive">{startError}</p>}
      </div>

      {(history.data?.length ?? 0) > 0 && (
        <nav aria-label="最近的巡检记录" className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
          <span className="me-1">最近</span>
          {history.data!.slice(0, 6).map((inspection) => (
            <button
              key={inspection.id}
              type="button"
              aria-current={inspection.id === currentId ? 'true' : undefined}
              onClick={() => openInspection(inspection.id)}
              className={cn(
                'min-h-7 rounded-md px-2 tabular-nums transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                inspection.id === currentId && 'bg-muted text-foreground',
              )}
            >
              {formatTime(inspection.created_at)} {inspection.label} · {STATUS_LABEL[inspection.status]}
            </button>
          ))}
        </nav>
      )}

      <div className="mt-6">
        {isLoading && <p className="text-sm text-muted-foreground">正在载入巡检结果…</p>}
        {!isLoading && !hasMessages && pendingStart === null && (
          <p className="rounded-lg bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">选择范围后开始巡检。</p>
        )}
        <ThreadPrimitive.Messages components={{ UserMessage: LabUserMessage, AssistantMessage: LabAssistantMessage }} />
      </div>
    </div>
  );
};

export const ScopedInspectionSheet: FC<{ open: boolean; onOpenChange: (open: boolean) => void }> = ({ open, onOpenChange }) => {
  const client = useContext(LmaClientContext);
  if (!client) {
    return null;
  }
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      const url = new URL(window.location.href);
      if (url.searchParams.has('labThread')) {
        url.searchParams.delete('labThread');
        window.history.replaceState(null, '', url);
      }
    }
    onOpenChange(nextOpen);
  };
  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4 sm:px-6">
          <SheetTitle>按范围巡检</SheetTitle>
          <SheetDescription>按全部、分组或单站执行逐站初筛与曲线初判，结果会同步更新到今日概览与测点列表。</SheetDescription>
        </SheetHeader>
        <AuiProvider extends={null} config={AuiConfig({})}>
          <LabRuntimeProvider client={client}>
            <ScopedInspectionBody compact />
          </LabRuntimeProvider>
        </AuiProvider>
      </SheetContent>
    </Sheet>
  );
};

export const InspectionLabPage: FC = () => {
  const client = useContext(LmaClientContext);
  if (!client) {
    return null;
  }
  return (
    <section aria-label="专项巡检" className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <AuiProvider extends={null} config={AuiConfig({})}>
        <LabRuntimeProvider client={client}>
          <ScopedInspectionBody />
        </LabRuntimeProvider>
      </AuiProvider>
    </section>
  );
};
