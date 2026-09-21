import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, RefreshCw, Server } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createLangGraphClient,
  getStoredApiUrl,
  LMA_ASSISTANT_ID,
  setStoredApiUrl,
} from '@/services/api';

interface ServiceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

function getPublicErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return '连接超时，请检查服务是否已启动。';
  }
  return '连接失败，请检查服务地址与目标 Assistant 配置。';
}

/**
 * LangGraph 服务配置只承载连接设置，不参与 Runtime、Thread 或消息生命周期。
 * 生产环境锁定同源端点；开发环境允许测试并保存地址。
 */
export function ServiceSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: ServiceSettingsDialogProps) {
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const isProduction = import.meta.env.PROD;

  useEffect(() => {
    if (!open) return;
    setApiUrl(getStoredApiUrl());
    setStatus('idle');
    setStatusMessage('');
  }, [open]);

  const normalizedUrl = apiUrl.trim();

  const testConnection = async () => {
    if (!normalizedUrl) {
      setStatus('error');
      setStatusMessage('请输入 LangGraph API 地址。');
      return;
    }

    setStatus('testing');
    setStatusMessage('正在连接 LangGraph 服务…');
    try {
      const assistant = await createLangGraphClient(normalizedUrl).assistants.get(
        LMA_ASSISTANT_ID,
      );
      if (
        assistant.assistant_id !== LMA_ASSISTANT_ID &&
        assistant.graph_id !== LMA_ASSISTANT_ID
      ) {
        throw new Error('assistant_mismatch');
      }
      setStatus('success');
      setStatusMessage('连接成功，已验证 lma-agent Assistant 可用。');
    } catch (error) {
      setStatus('error');
      setStatusMessage(getPublicErrorMessage(error));
    }
  };

  const save = () => {
    if (!isProduction) {
      if (!normalizedUrl) {
        setStatus('error');
        setStatusMessage('请输入 LangGraph API 地址。');
        return;
      }
      setStoredApiUrl(normalizedUrl);
    }
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-neutral-100 px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-sm text-neutral-800">
            <Server className="size-4 text-indigo-600" />
            LangGraph 服务对接配置
          </DialogTitle>
          <DialogDescription>
            配置并验证滑坡监测智能体的服务连接。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-5 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="langgraph-api-url" className="font-medium text-neutral-700">
              LangGraph API 地址
            </label>
            {isProduction ? (
              <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-neutral-500">
                <Lock className="size-3.5 shrink-0 text-neutral-400" />
                <span className="truncate font-mono">已由系统安全托管（生产同源连接）</span>
              </div>
            ) : (
              <Input
                id="langgraph-api-url"
                value={apiUrl}
                onChange={(event) => {
                  setApiUrl(event.target.value);
                  setStatus('idle');
                  setStatusMessage('');
                }}
                placeholder="请输入 LangGraph API 地址或 /langgraph-api"
                className="font-mono text-xs"
                aria-invalid={status === 'error' && !normalizedUrl}
              />
            )}
            <p className="text-[11px] leading-relaxed text-neutral-400">
              {isProduction
                ? '生产模式锁定服务端端点与鉴权通道，避免越权修改连接。'
                : '测试会同时验证服务连通性与 lma-agent Assistant。'}
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={testConnection}
            disabled={status === 'testing'}
          >
            <RefreshCw className={status === 'testing' ? 'animate-spin' : undefined} />
            {status === 'testing' ? '测试中…' : '测试连通性'}
          </Button>

          {status !== 'idle' && (
            <div
              role={status === 'error' ? 'alert' : 'status'}
              className={
                status === 'success'
                  ? 'flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-700'
                  : status === 'error'
                    ? 'flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700'
                    : 'rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-neutral-500'
              }
            >
              {status === 'success' && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
              {status === 'error' && <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-neutral-100 bg-neutral-50 px-5 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={save}>
            保存并应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
