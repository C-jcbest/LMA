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

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文（http）下 clipboard API 不可用，降级为 execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }
  };

  const handleCopy = async () => {
    const text = getText();
    if (!text.trim()) return;
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
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
        title="复制"
        className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
      {copied && <span className="text-[11px] text-neutral-400 select-none">已复制</span>}
    </div>
  );
};
