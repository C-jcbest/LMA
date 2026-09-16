import React, { useCallback, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  message: string;
  type?: 'error' | 'warning' | 'info';
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="系统通知"
      className="fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none max-w-sm"
    >
      {toasts.map((toast) => {
        const isError = toast.type === 'error';
        const isWarning = toast.type === 'warning';
        return (
          <div
            key={toast.id}
            role={isError ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border bg-white shadow-lg text-xs text-neutral-800 transition-all animate-in fade-in slide-in-from-top-2 duration-150 ${
              isError
                ? 'border-red-200'
                : isWarning
                  ? 'border-amber-200'
                  : 'border-neutral-200'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {isError ? (
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              ) : isWarning ? (
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              ) : (
                <Info className="w-4 h-4 text-neutral-400 shrink-0" />
              )}
              <span className="truncate">{toast.message}</span>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="关闭通知"
              className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export const useToast = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: 'error' | 'warning' | 'info' = 'error') => {
      if (!message.trim()) return;
      setToasts((current) => {
        // 相同消息去重：已存在同文通知则不重复添加
        if (current.some((t) => t.message === message)) {
          return current;
        }
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const nextToast: ToastItem = { id, message, type };

        // 默认 4 秒自动消失（处于 3-5 秒范围）
        const timer = window.setTimeout(() => {
          dismissToast(id);
        }, 4000);
        timersRef.current.set(id, timer);

        // 最多同时保留 3 条，超出时淘汰最早的
        const list = current.length >= 3 ? current.slice(current.length - 2) : current;
        return [...list, nextToast];
      });
    },
    [dismissToast]
  );

  return { toasts, showToast, dismissToast };
};
