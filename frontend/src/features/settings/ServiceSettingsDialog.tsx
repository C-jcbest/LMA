import { useEffect, useState } from 'react';
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
  createLmaClient,
  getStoredApiUrl,
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
  return '连接失败，请检查服务地址与数据库配置。';
}

const STATUS_TEXT_CLASS: Record<ConnectionStatus, string> = {
  idle: '',
  testing: 'text-muted-foreground',
  success: 'text-status-normal',
  error: 'text-destructive',
};

/**
 * 仅开发环境提供：生产环境固定同源端点，普通用户没有需要配置的内容。
 * 只承载连接设置，不参与 Runtime、Thread 或消息生命周期。
 */
export function ServiceSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: ServiceSettingsDialogProps) {
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');

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
      setStatusMessage('请输入 LMA API 地址。');
      return;
    }

    setStatus('testing');
    setStatusMessage('正在连接 LMA 服务…');
    try {
      const service = await createLmaClient(normalizedUrl).health();
      if (!service.ok || service.service !== 'lma') throw new Error('service_mismatch');
      setStatus('success');
      setStatusMessage('连接成功，LMA 服务与数据库可用。');
    } catch (error) {
      setStatus('error');
      setStatusMessage(getPublicErrorMessage(error));
    }
  };

  const save = () => {
    if (!normalizedUrl) {
      setStatus('error');
      setStatusMessage('请输入 LMA API 地址。');
      return;
    }
    setStoredApiUrl(normalizedUrl);
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>LMA 服务对接配置</DialogTitle>
          <DialogDescription>配置并验证滑坡监测智能体的服务连接。</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="langgraph-api-url" className="text-sm font-medium">
            LMA API 地址
          </label>
          <Input
            id="langgraph-api-url"
            value={apiUrl}
            onChange={(event) => {
              setApiUrl(event.target.value);
              setStatus('idle');
              setStatusMessage('');
            }}
            placeholder="请输入 LMA API 地址或 /api"
            aria-invalid={status === 'error' && !normalizedUrl}
          />
          {status !== 'idle' && (
            <p role={status === 'error' ? 'alert' : 'status'} className={`text-sm ${STATUS_TEXT_CLASS[status]}`}>
              {statusMessage}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" className="sm:me-auto" onClick={testConnection} disabled={status === 'testing'}>
            {status === 'testing' ? '测试中…' : '测试连通性'}
          </Button>
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
