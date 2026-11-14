import { useAuiState } from '@assistant-ui/react';
import { Mountain } from 'lucide-react';
import { useConversationLoading } from '@/app/providers/AssistantProvider';

/** 空会话的占位；新调查和推荐问题都从首页开始，这里只提示可以直接提问。 */
export function NewInvestigation() {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const loading = useConversationLoading();
  if (loading) {
    return null;
  }
  return (
    <section key={threadId} aria-label="新调查" className="new-investigation mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-10 sm:py-16">
      <div className="new-investigation-intro">
        <div className="mb-6 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs">
          <Mountain aria-hidden className="size-6 text-foreground/80" />
        </div>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">从一个问题开始</h1>
      </div>
    </section>
  );
}
