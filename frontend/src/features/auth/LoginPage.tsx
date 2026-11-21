import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2Icon, Mountain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';
import type { LmaClient } from '@/services/api';

const EXIT_DURATION_MS = 200;

export function LoginPage({ client, expired, onSuccess }: { client: LmaClient; expired: boolean; onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<'entering' | 'shown' | 'leaving'>('entering');
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPhase('shown'));
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await client.login(username.trim(), password);
      setPhase('leaving');
      window.setTimeout(onSuccess, EXIT_DURATION_MS);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登录失败，请重试。');
      setPassword('');
      setSubmitting(false);
      passwordRef.current?.focus();
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <form
        onSubmit={submit}
        aria-label="登录"
        className={cn(
          'w-full max-w-sm transition duration-300 ease-out',
          phase === 'entering' && 'translate-y-2 opacity-0',
          phase === 'leaving' && 'scale-98 opacity-0 duration-200 ease-in',
        )}
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-card shadow-xs">
            <Mountain aria-hidden className="size-6 text-foreground/80" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">LMA Monitor</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {expired ? '登录已过期，请重新登录' : '滑坡监测智能体'}
          </p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-sm text-muted-foreground">账号</span>
            <Input
              name="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              className="h-10"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-muted-foreground">密码</span>
            <Input
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby="login-error"
              className="h-10"
            />
          </label>
        </div>

        <p
          id="login-error"
          role="alert"
          className={cn(
            'mt-3 min-h-5 text-sm text-destructive transition-opacity duration-200',
            error ? 'opacity-100' : 'opacity-0',
          )}
        >
          {error}
        </p>

        <Button type="submit" className="mt-2 h-10 w-full" disabled={submitting || !username.trim() || !password}>
          {submitting && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
          登录
        </Button>
      </form>
    </main>
  );
}
