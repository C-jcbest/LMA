import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface MessageActionsProps {
  getText: () => string;
  align?: 'left' | 'right';
}

/**
 * 消息底部悬浮工具栏：鼠标悬浮在消息上时显示操作图标。
 * 当前仅提供复制功能，后续可在此扩展（重新生成等）。
 */
export const MessageActions: React.FC<MessageActionsProps> = ({ getText, align = 'left' }) => {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

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
      className={`flex items-center gap-1 pt-1 opacity-0 group-hover:opacity-100 transition-opacity ${
        align === 'right' ? 'justify-end' : ''
      }`}
    >
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
  );
};
