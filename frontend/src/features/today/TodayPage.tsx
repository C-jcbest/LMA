import { useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { ArrowUpIcon, ArrowUpLeft } from 'lucide-react';
import { useNavigation } from '@/app/navigation';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import { Button } from '@/components/ui/button';
import { TodayAttention } from './TodayAttention';

/**
 * 推荐问题只在首页、只来自最近巡检与登记结论里的真实线索；没有线索时不显示。
 * 读取推荐不阻塞首页，迟到的推荐也不覆盖已输入的草稿（草稿非空时不显示）。
 */
function HomeSuggestions({ onPick }: { onPick: (question: string) => void }) {
  const client = useLmaClient();
  const request = useRef<Promise<string[]> | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    // StrictMode 重放 effect 时复用本次请求；推荐不进入会话运行时。
    if (!request.current) {
      request.current = client.suggestQuestions().catch(() => []);
    }
    void request.current.then((result) => {
      if (active) {
        setQuestions(result);
      }
    });
    return () => { active = false; };
  }, [client]);

  if (questions.length === 0) {
    return null;
  }
  return (
    <ul aria-label="推荐问题" className="mb-2 flex flex-wrap gap-2">
      {questions.map((question, index) => (
        <li key={question} className="new-investigation-question" style={{ animationDelay: `${index * 70}ms` }}>
          <button type="button" onClick={() => onPick(question)}
            className="group flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>{question}</span>
            <ArrowUpLeft aria-hidden className="size-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 首页草稿与当前会话分开，直到发送才切换到新的官方会话运行时。 */
export function TodayPage({ draft, onDraftChange }: { draft: string; onDraftChange: (text: string) => void }) {
  const aui = useAui();
  const { showConversation, homeFocusRequest } = useNavigation();
  const [sending, setSending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 侧栏“新调查”回到首页时聚焦输入框；首次进入首页不抢焦点。
  useEffect(() => {
    if (homeFocusRequest > 0) {
      inputRef.current?.focus();
    }
  }, [homeFocusRequest]);

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
      <div className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col px-4 pt-6 sm:px-6 sm:pt-8">
        <TodayAttention />
        <form className="sticky bottom-0 mt-auto bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {hasError && <p role="alert" className="mb-2 text-sm">新调查尚未打开，请重试。</p>}
          {!draft.trim() && <HomeSuggestions onPick={(question) => {
            onDraftChange(question);
            inputRef.current?.focus();
          }} />}
          <div className="aui-composer-root relative flex items-end gap-2 rounded-[1.25rem] border bg-card py-2 ps-4 pe-2 shadow-xs focus-within:border-ring">
            <textarea ref={inputRef} aria-label="输入监测问题" placeholder="询问监测数据、变化趋势、降雨关联或场地环境…"
              value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={sending}
              rows={2} enterKeyHint="send"
              className="max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-base leading-6 outline-none placeholder:text-muted-foreground/60 [field-sizing:content]"
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
