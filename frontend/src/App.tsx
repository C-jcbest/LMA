import React, { useMemo, useState } from 'react';
import { createLangGraphClient, getStoredApiUrl } from '@/services/api';
import { AssistantProvider } from './app/providers/AssistantProvider';
import { AppLayout } from './app/AppLayout';
import { ConfigModal } from './components/ConfigModal';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * 根应用入口：
 * 仅负责组装唯一 Runtime Provider (AssistantProvider)、AppLayout、设置弹窗与全局 ErrorBoundary。
 * 绝不自行维护消息状态机、流式生命周期或会话目录轮询。
 */
export const App: React.FC = () => {
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);

  const client = useMemo(() => createLangGraphClient(apiUrl), [apiUrl]);

  return (
    <ErrorBoundary fallbackTitle="会话界面加载异常" level="window">
      <AssistantProvider key={apiUrl} client={client}>
        <AppLayout onOpenSettings={() => setIsConfigOpen(true)} />
      </AssistantProvider>

      <ConfigModal
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        onSaved={() => {
          const nextUrl = getStoredApiUrl();
          if (nextUrl !== apiUrl) {
            setApiUrl(nextUrl);
          }
        }}
      />
    </ErrorBoundary>
  );
};
