import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface MessageActionsProps {
  getText: () => string;
  align?: 'left' | 'right';
  timestamp?: string;
}

const formatDisplayTime = (ts?: string) => {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) {
      const hours = d.getHours().toString().padStart(2, '0');
      const minutes = d.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    }
  } catch {
    // 降级原样返回
  }
  return ts;
};

/**
 * 消息底部工具栏：包含消息时间显示，鼠标悬浮时展示操作图标（复制等）。
 */
export const MessageActions: React.FC<MessageActionsProps> = ({ getText, align = 'left', timestamp }) => {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [initialTime] = useState(() => {
    if (timestamp) return formatDisplayTime(timestamp);
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  });

  const displayTime = timestamp ? formatDisplayTime(timestamp) : initialTime;

  const handleCopy = async () => {
    const text = getText();
    if (!text.trim()) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <div
      className={`flex items-center gap-1.5 pt-1 text-[11px] text-neutral-400 ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      {align === 'left' && (
        <span className="font-mono text-[11px] text-neutral-400 select-none tracking-tight">
          {displayTime}
        </span>
      )}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={handleCopy}
          title={copyError ? '复制失败：浏览器未开放剪贴板权限' : '复制'}
          aria-label={copyError ? '复制失败：浏览器未开放剪贴板权限' : '复制'}
          className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-500" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
        {copied && <span className="text-[11px] text-neutral-400 select-none">已复制</span>}
        {copyError && <span className="text-[11px] text-red-500 select-none">复制失败</span>}
      </div>
      {align === 'right' && (
        <span className="font-mono text-[11px] text-neutral-400 select-none tracking-tight">
          {displayTime}
        </span>
      )}
    </div>
  );
};
