import { useMemo, useState, type FC } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { useNavigation } from '@/app/navigation';
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { matchesSessionStatusFilter, useSessionVerdicts, type SessionStatusFilter } from './SessionConclusions';

const BASE_FILTER_OPTIONS: readonly { value: SessionStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '需人工复核', label: '需人工复核' },
  { value: '持续关注', label: '持续关注' },
  { value: '数据待核查', label: '数据待核查' },
  { value: '未见明显变化', label: '未见明显变化' },
  { value: 'none', label: '未形成结论' },
];

export const RecordsPage: FC = () => {
  const { showConversation } = useNavigation();
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const verdicts = useSessionVerdicts();

  const filterOptions = useMemo<SegmentedOption[]>(() => {
    const counts = new Map<SessionStatusFilter, number>();
    for (const option of BASE_FILTER_OPTIONS) {
      counts.set(option.value, 0);
    }
    for (const item of threadItems) {
      const verdict = verdicts.get(item.remoteId ?? item.id);
      for (const option of BASE_FILTER_OPTIONS) {
        if (matchesSessionStatusFilter(verdict, option.value)) {
          counts.set(option.value, (counts.get(option.value) ?? 0) + 1);
        }
      }
    }
    return BASE_FILTER_OPTIONS
      .filter((option) => option.value === 'all' || option.value === statusFilter || (counts.get(option.value) ?? 0) > 0)
      .map((option) => ({
        value: option.value,
        label: option.label,
        count: threadItems.length > 0 ? counts.get(option.value) : undefined,
      }));
  }, [threadItems, verdicts, statusFilter]);

  return (
    <section aria-label="调查记录" className="page-column flex h-full flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">调查记录</h1>
        <div className="max-w-full overflow-x-auto">
          <Segmented
            label="结论状态筛选"
            options={filterOptions}
            value={statusFilter}
            onValueChange={(next) => setStatusFilter(next as SessionStatusFilter)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ThreadList variant="all" statusFilter={statusFilter} onNavigate={showConversation} />
      </div>
    </section>
  );
};
