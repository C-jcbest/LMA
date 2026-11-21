import { useContext, useEffect, useState, type FC } from 'react';
import { AuiConfig, AuiProvider, MessagePrimitive, ThreadPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { LmaClientContext } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

const LabUserMessage: FC = () => (
  <MessagePrimitive.Root className="mb-2 text-xs text-muted-foreground">
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

interface ScopePickerProps {
  groups: readonly LabScopeGroup[];
  onStart: (scope: LabScope, label: string) => void;
  disabled: boolean;
}

const ScopePicker: FC<ScopePickerProps> = ({ groups, onStart, disabled }) => {
  const [kind, setKind] = useState<ScopeKind>('all');
  const [groupUuid, setGroupUuid] = useState('');
  const [stationUuid, setStationUuid] = useState('');
  const stations = groups.flatMap((group) => group.stations.map((station) => ({ ...station, groupName: group.group_name })));

  let scope: LabScope | null = { kind: 'all' };
  let label = '全部测点';
  if (kind === 'group') {
    const group = groups.find((item) => item.group_uuid === groupUuid);
    scope = group ? { kind: 'group', group_uuid: group.group_uuid } : null;
    label = group ? `${group.group_name} 分组` : '';
  } else if (kind === 'station') {
    const station = stations.find((item) => item.station_uuid === stationUuid);
    scope = station ? { kind: 'station', station_uuid: station.station_uuid } : null;
    label = station ? station.station_name : '';
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented label="巡检范围" value={kind} options={SCOPE_OPTIONS} onValueChange={(value) => setKind(value as ScopeKind)} />
      {kind === 'group' && (
        <Select value={groupUuid} onValueChange={setGroupUuid}>
          <SelectTrigger size="sm" aria-label="选择分组" className="min-w-44"><SelectValue placeholder="选择分组" /></SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectItem key={group.group_uuid} value={group.group_uuid}>{group.group_name}（{group.stations.length}）</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {kind === 'station' && (
        <Select value={stationUuid} onValueChange={setStationUuid}>
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
      <Button type="button" size="sm" disabled={disabled || scope === null} onClick={() => scope && onStart(scope, label)}>
        <PlayIcon className="size-3.5" aria-hidden />
        开始巡检
      </Button>
    </div>
  );
};

const LabContent: FC = () => {
  const client = useContext(LmaClientContext)!;
  const aui = useAui();
  const queryClient = useQueryClient();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);
  const currentId = useAuiState((state) =>
    state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const scopes = useQuery({ queryKey: ['lab-scopes'], queryFn: ({ signal }) => client.listLabScopes(signal), staleTime: 5 * 60_000 });
  const history = useQuery({ queryKey: ['lab-inspections'], queryFn: ({ signal }) => client.listLabInspections(signal) });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['lab-inspections'] });
  }, [isRunning, queryClient]);

  const openInspection = useOpenLabInspection();
  const [pendingStart, setPendingStart] = useState<{ id: string; scope: LabScope; label: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = async (scope: LabScope, label: string) => {
    setStartError(null);
    try {
      const created = await client.createLabInspection();
      setPendingStart({ id: created.id, scope, label });
      openInspection(created.id);
    } catch {
      setStartError('原型巡检未能创建，请稍后重试。');
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
    <div className="@container mx-auto w-full max-w-208 px-4 pt-6 pb-10 sm:px-6 sm:pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">巡检原型</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        点击巡检后，服务端逐站推送结果：先列出范围内的测点，初筛完成一站更新一站；建议调查的测点再由视觉模型看 90 天曲线给出一句初判。初判不是调查结论，也不写入今日页。
      </p>

      <div className="mt-5">
        {scopes.isError && <p role="alert" className="text-sm text-muted-foreground">测点列表尚未载入。</p>}
        <ScopePicker
          groups={scopes.data ?? []}
          onStart={(scope, label) => void start(scope, label)}
          disabled={isRunning || pendingStart !== null || !scopes.data}
        />
        {startError && <p role="alert" className="mt-2 text-sm text-destructive">{startError}</p>}
      </div>

      {(history.data?.length ?? 0) > 0 && (
        <nav aria-label="最近的原型巡检" className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
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

export const InspectionLabPage: FC = () => {
  const client = useContext(LmaClientContext);
  if (!client) {
    return null;
  }
  return (
    <section aria-label="巡检原型" className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <AuiProvider extends={null} config={AuiConfig({})}>
        <LabRuntimeProvider client={client}>
          <LabContent />
        </LabRuntimeProvider>
      </AuiProvider>
    </section>
  );
};
