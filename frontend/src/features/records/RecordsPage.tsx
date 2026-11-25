import { useState, type FC } from 'react';
import { useNavigation } from '@/app/navigation';
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui';
import { Segmented } from '@/components/ui/segmented';
import type { SessionStatusFilter } from './SessionConclusions';

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: '需人工复核', label: '需人工复核' },
  { value: '持续关注', label: '持续关注' },
  { value: 'none', label: '未形成结论' },
] as const;

export const RecordsPage: FC = () => {
  const { showConversation } = useNavigation();
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');

  return (
    <section aria-label="调查记录" className="page-column flex h-full flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">调查记录</h1>
        <Segmented
          label="结论状态筛选"
          options={STATUS_FILTER_OPTIONS}
          value={statusFilter}
          onValueChange={(next) => setStatusFilter(next as SessionStatusFilter)}
        />
      </div>
      <div className="min-h-0 flex-1">
        <ThreadList variant="all" statusFilter={statusFilter} onNavigate={showConversation} />
      </div>
    </section>
  );
};
