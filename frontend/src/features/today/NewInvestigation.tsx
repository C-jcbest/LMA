import { useEffect, useRef, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ArrowUpLeft, Mountain } from 'lucide-react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { useStationInspector } from '@/features/monitoring/StationInspectorContext';
import { useConversationLoading } from '@/app/providers/AssistantProvider';

export function NewInvestigation() {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const loading = useConversationLoading();
  if (loading) {
    return null;
  }
  return <InvestigationWelcome key={threadId} />;
}

function InvestigationWelcome() {
  const client = useLmaClient();
  const aui = useAui();
  const { composerInputRef } = useStationInspector();
  const draft = useAuiState((state) => state.composer.text);
  const request = useRef<Promise<string[]> | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    // StrictMode 重放 effect 时复用本次请求；推荐不进入会话运行时。
    if (!request.current) {
      request.current = client.suggestQuestions().catch(() => []);
    }
    void request.current.then((result) => {
      if (active) {
        setQuestions(result);
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, [client]);

  return (
    <section aria-label="新调查" className="new-investigation mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-10 sm:py-16">
      <div className="new-investigation-intro mb-8">
        <div className="mb-6 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs">
          <Mountain aria-hidden className="size-6 text-foreground/80" />
        </div>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">从一个问题开始</h1>
      </div>
      <div className="min-h-44">
        {!draft.trim() && loading && (
          <div aria-hidden className="space-y-3">
            {[80, 95, 70].map((width) => (
              <div key={width} className="h-11 animate-pulse rounded-xl bg-muted/50 motion-reduce:animate-none" style={{ width: `${width}%` }} />
            ))}
          </div>
        )}
        {!draft.trim() && !loading && (
          <div className="space-y-2">
            {questions.map((question, index) => (
              <button key={question} type="button"
                className="new-investigation-question group flex min-h-12 w-full items-center justify-between gap-4 rounded-xl border border-transparent px-3 py-3 text-left text-sm leading-6 text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ animationDelay: `${index * 70}ms` }}
                onClick={() => {
                  aui.composer().setText(question);
                  composerInputRef.current?.focus();
                }}>
                <span>{question}</span>
                <ArrowUpLeft aria-hidden className="size-4 shrink-0 opacity-50 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
