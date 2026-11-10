import type { FC } from 'react';
import { useNavigation } from '@/app/navigation';
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui';

/** 每次提问是一条记录；有简报的记录带上涉及的测点和结论。 */
export const RecordsPage: FC = () => {
  const { showConversation } = useNavigation();

  return (
    <section aria-label="调查记录" className="page-column flex h-full flex-col">
      <h1 className="mb-5 shrink-0 text-2xl font-semibold tracking-tight">调查记录</h1>
      <div className="min-h-0 flex-1">
        <ThreadList variant="all" onNavigate={showConversation} />
      </div>
    </section>
  );
};
