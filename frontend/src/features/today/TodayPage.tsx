import { useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { ArrowUpIcon } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { TodayAttention } from './TodayAttention';

/** 首页草稿与当前会话分开，直到发送才切换到新的官方会话运行时。 */
export function TodayPage({ draft, onDraftChange }: { draft: string; onDraftChange: (text: string) => void }) {
  const aui = useAui();
  const { showConversation } = useNavigation();
  const [sending, setSending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const submitting = useRef(false);

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
    <section aria-label="今日页面" className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col px-4 pt-6 sm:px-6 sm:pt-8">
        <TodayAttention />
        <form className="sticky bottom-0 mt-auto bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {hasError && <p role="alert" className="mb-2 text-sm">新调查尚未打开，请重试。</p>}
          <div className="aui-composer-root relative flex items-end gap-2 rounded-[1.25rem] border bg-card py-2 ps-4 pe-2 shadow-xs focus-within:border-ring">
            <textarea aria-label="输入监测问题" placeholder="询问监测数据、变化趋势、降雨关联或场地环境…"
              value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={sending}
              rows={2} enterKeyHint="send"
              className="max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-base leading-6 outline-none placeholder:text-muted-foreground [field-sizing:content]"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }} />
            <Button type="submit" size="icon" aria-label="发送消息" disabled={sending || !draft.trim()} className="size-9 shrink-0 rounded-full">
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
