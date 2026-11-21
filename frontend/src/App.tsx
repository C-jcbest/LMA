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
