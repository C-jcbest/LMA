import { useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { ArrowUpIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigation } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { EASE_IN, EASE_OUT } from '@/components/ui/motion-primitives';
import { ScopedInspectionSheet } from '@/features/lab/InspectionLabPage';
import { TodayAttention } from './TodayAttention';

const QUICK_STARTERS = [
  '分析最新建议调查测点的位移与降雨关联',
  '对比同组测点近期变化是否同步',
];

export function TodayPage({
  draft,
  onDraftChange,
  initialScopedOpen = false,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  initialScopedOpen?: boolean;
}) {
  const aui = useAui();
  const { showConversation } = useNavigation();
  const [sending, setSending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [scopedOpen, setScopedOpen] = useState(initialScopedOpen);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialScopedOpen) {
      setScopedOpen(true);
    }
  }, [initialScopedOpen]);

  const send = async () => {
    const text = draft.trim();
    if (!text || submitting.current) {
      return;
    }
    submitting.current = true;
    setSending(true);
    setHasError(false);
    try {
      await aui.threads().switchToNewThread();
      aui.thread().append({ role: 'user', content: [{ type: 'text', text }] });
      onDraftChange('');
      showConversation();
    } catch {
      setHasError(true);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  return (
    <section aria-label="今日页面" className="@container h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex min-h-full w-full max-w-208 flex-col px-4 pt-6 sm:px-6 sm:pt-8">
        <TodayAttention onOpenScopedInspection={() => setScopedOpen(true)} />
        <form className="sticky bottom-0 mt-auto bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {hasError && <p role="alert" className="mb-2 text-sm text-destructive">新调查尚未打开，请重试。</p>}
          <AnimatePresence initial={false}>
            {!draft.trim() && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto', transition: EASE_OUT }}
                exit={{ opacity: 0, height: 0, transition: EASE_IN }}
                className="overflow-hidden"
              >
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {QUICK_STARTERS.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => {
                        onDraftChange(starter);
                        inputRef.current?.focus();
                      }}
                      className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition hover:border-border hover:bg-muted hover:text-foreground active:scale-98 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="aui-composer-root relative flex items-end gap-2 rounded-xl border bg-card py-2 ps-4 pe-2 shadow-xs focus-within:border-ring">
            <textarea
              ref={inputRef}
              aria-label="输入监测问题"
              placeholder="询问监测数据、变化趋势、降雨关联或场地环境…"
              value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={sending}
              rows={2} enterKeyHint="send"
              className="max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-base leading-6 outline-none placeholder:text-muted-foreground/60 [field-sizing:content]"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }} />
            <Button type="submit" size="icon" aria-label="发送消息" disabled={sending || !draft.trim()} className="size-8 shrink-0 rounded-full">
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </form>
      </div>
      <ScopedInspectionSheet open={scopedOpen} onOpenChange={setScopedOpen} />
    </section>
  );
}
