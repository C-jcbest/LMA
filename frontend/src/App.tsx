import React, { useEffect, useMemo, useState } from 'react';
import { createLmaClient, getStoredApiUrl, UNAUTHORIZED_EVENT } from '@/services/api';
import { AssistantProvider } from './app/providers/AssistantProvider';
import { AppLayout } from './app/AppLayout';
import { ThemeProvider } from './app/providers/ThemeProvider';
import { LoginPage } from './features/auth/LoginPage';
import { ServiceSettingsDialog } from './features/settings/ServiceSettingsDialog';
import { ErrorBoundary } from './components/ErrorBoundary';

type AccessState =
  | { kind: 'checking' }
  | { kind: 'login'; expired: boolean }
  | { kind: 'ready'; authEnabled: boolean };

/**
 * 根应用入口：
 * 先确认访问状态（未登录时只显示登录页），再组装唯一 Runtime Provider (AssistantProvider)、AppLayout、设置弹窗与全局 ErrorBoundary。
 * 绝不自行维护消息状态机、流式生命周期或会话目录轮询。
 */
export const App: React.FC = () => {
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  const [access, setAccess] = useState<AccessState>({ kind: 'checking' });

  const client = useMemo(() => createLmaClient(apiUrl), [apiUrl]);

  useEffect(() => {
    let active = true;
    client.getAuthSession()
      .then((session) => {
        if (!active) {
          return;
        }
        if (session.authenticated) {
          setAccess({ kind: 'ready', authEnabled: session.enabled });
        } else {
          setAccess({ kind: 'login', expired: false });
        }
      })
      .catch(() => {
        // 服务暂时不可达时先进入应用，由各页面显示连接错误；真正未登录的请求会返回 401 回到登录页。
        if (active) {
          setAccess({ kind: 'ready', authEnabled: false });
        }
      });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    const showLogin = () => setAccess((current) => (
      current.kind === 'login' ? current : { kind: 'login', expired: current.kind === 'ready' }
    ));
    window.addEventListener(UNAUTHORIZED_EVENT, showLogin);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, showLogin);
  }, []);

  if (access.kind === 'checking') {
    return null;
  }

  if (access.kind === 'login') {
    return (
      <ThemeProvider>
        <LoginPage
          client={client}
          expired={access.expired}
          onSuccess={() => setAccess({ kind: 'ready', authEnabled: true })}
        />
      </ThemeProvider>
    );
  }

  const logout = async () => {
    try {
      await client.logout();
    } finally {
      setAccess({ kind: 'login', expired: false });
    }
  };

  return (
    <ErrorBoundary fallbackTitle="会话界面加载异常" level="window">
      <AssistantProvider key={apiUrl} client={client}>
        <AppLayout
          onOpenSettings={import.meta.env.DEV ? () => setIsConfigOpen(true) : undefined}
          onLogout={access.authEnabled ? logout : undefined}
        />
      </AssistantProvider>

      {import.meta.env.DEV && (
        <ServiceSettingsDialog
          open={isConfigOpen}
          onOpenChange={setIsConfigOpen}
          onSaved={() => {
            const nextUrl = getStoredApiUrl();
            if (nextUrl !== apiUrl) {
              setApiUrl(nextUrl);
            }
          }}
        />
      )}
    </ErrorBoundary>
  );
};
