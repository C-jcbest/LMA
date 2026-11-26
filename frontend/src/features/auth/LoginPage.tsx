import { useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { EyeIcon, EyeOffIcon, Loader2Icon, Mountain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EASE_IN, EASE_OUT, MorphIcon } from '@/components/ui/motion-primitives';
import type { LmaClient } from '@/services/api';

const EXIT_DURATION_MS = 200;

export function LoginPage({ client, expired, onSuccess }: { client: LmaClient; expired: boolean; onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await client.login(username.trim(), password);
      setLeaving(true);
      window.setTimeout(onSuccess, EXIT_DURATION_MS);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登录失败，请重试。');
      setSubmitting(false);
      requestAnimationFrame(() => {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      });
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <motion.form
        onSubmit={submit}
        aria-label="登录"
        initial={{ opacity: 0, y: 10 }}
        animate={leaving ? { opacity: 0, scale: 0.98 } : { opacity: 1, y: 0, scale: 1 }}
        transition={leaving ? EASE_IN : { duration: 0.28, ease: EASE_OUT.ease }}
        className="w-full max-w-sm rounded-xl border bg-card/60 p-6 sm:p-8"
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-background shadow-xs">
            <Mountain aria-hidden className="size-6 text-foreground/80" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">LMA Monitor</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {expired ? '登录已过期，请重新登录' : '滑坡监测智能体'}
          </p>
        </div>

        <div className="space-y-3.5">
          <div>
            <label htmlFor="login-username" className="mb-1.5 block text-sm text-muted-foreground">账号</label>
            <Input
              id="login-username"
              name="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                if (error) setError(null);
              }}
              disabled={submitting}
              className="h-10"
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-sm text-muted-foreground">密码</label>
            <div className="relative">
              <Input
                id="login-password"
                ref={passwordRef}
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                disabled={submitting}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                className="h-10 pe-10"
              />
              <button
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <MorphIcon activeKey={showPassword ? 'hide' : 'show'}>
                  {showPassword ? <EyeOffIcon className="size-4" aria-hidden /> : <EyeIcon className="size-4" aria-hidden />}
                </MorphIcon>
              </button>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {error && (
            <motion.p
              id="login-error"
              role="alert"
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={EASE_OUT}
              className="overflow-hidden text-sm text-destructive"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <Button type="submit" className="mt-5 h-10 w-full" disabled={submitting || !username.trim() || !password}>
          {submitting && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
          登录
        </Button>
      </motion.form>
    </main>
  );
}
