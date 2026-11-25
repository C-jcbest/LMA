import { useEffect, useRef, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpLeft, Mountain } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { EASE_IN, EASE_OUT } from '@/components/ui/motion-primitives';
import { Skeleton } from '@/components/ui/skeleton';
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
  const stationsQuery = useQuery({
    queryKey: ['stations'],
    queryFn: ({ signal }) => client.listStations?.(signal) ?? Promise.resolve([]),
  });

  useEffect(() => {
    let active = true;
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

  const stationCount = stationsQuery.data?.length ?? 0;

  return (
    <section aria-label="新调查" className="new-investigation mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-10 sm:py-16">
      <div className="new-investigation-intro mb-8">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl border bg-card shadow-xs">
          <Mountain aria-hidden className="size-6 text-foreground/80" />
        </div>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">从一个问题开始</h1>
        {stationCount > 0 && (
          <p className="mt-2 text-sm text-muted-foreground tabular-nums">
            已接入 {stationCount} 个测点，直接描述问题、测点名称或时间范围即可开始分析。
          </p>
        )}
      </div>
      <div className="min-h-44">
        <AnimatePresence mode="wait">
          {!draft.trim() && loading && (
            <motion.div
              key="skeleton"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: EASE_OUT }}
              exit={{ opacity: 0, transition: EASE_IN }}
              className="space-y-2"
            >
              {['88%', '94%', '82%'].map((width) => (
                <Skeleton key={width} className="h-12 rounded-lg" style={{ width }} />
              ))}
            </motion.div>
          )}
          {!draft.trim() && !loading && (
            <motion.div
              key="questions"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: EASE_OUT }}
              exit={{ opacity: 0, transition: EASE_IN }}
              className="space-y-2"
            >
              {questions.map((question, index) => (
                <motion.button
                  key={question}
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { ...EASE_OUT, delay: index * 0.04 } }}
                  className="group flex min-h-12 w-full items-center justify-between gap-4 rounded-lg border border-transparent px-3 py-3 text-left text-sm leading-6 text-muted-foreground transition hover:border-border hover:bg-card hover:text-foreground active:scale-99 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    aui.composer().setText(question);
                    composerInputRef.current?.focus();
                  }}
                >
                  <span>{question}</span>
                  <ArrowUpLeft aria-hidden className="size-4 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
