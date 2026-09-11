import React, { useState } from 'react';
import { ChevronDown, Archive } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';

interface SummaryCardProps {
  summary: string;
}

/**
 * 历史对话摘要卡：上下文压缩发生后，在消息列表头部展示
 * 折叠的持久摘要，提示更早的对话已压缩。
 */
export const SummaryCard: React.FC<SummaryCardProps> = ({ summary }) => {
  const [expanded, setExpanded] = useState(false);

  if (!summary) return null;

  return (
    <div className="max-w-4xl mx-auto w-full">
      <div className="border border-neutral-200/90 rounded-2xl bg-neutral-50/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-neutral-100/70 transition-colors"
        >
          <Archive className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
          <span className="text-xs text-neutral-500 flex-1">更早的对话已压缩为摘要</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-neutral-400 shrink-0 transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </button>
        {expanded && (
          <div className="px-4 pb-3 pt-1 border-t border-neutral-200/70 text-xs text-neutral-600">
            <MarkdownMessage content={summary} />
          </div>
        )}
      </div>
    </div>
  );
};
