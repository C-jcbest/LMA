import React from 'react';
import { Sparkles } from 'lucide-react';

interface ThinkingIndicatorProps {
  statusText?: string;
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  statusText = '智能体正在检索北斗平台与分析监测数据...',
}) => {
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500 py-1.5 animate-pulse">
      <div className="w-4 h-4 rounded-full bg-neutral-100 flex items-center justify-center">
        <Sparkles className="w-2.5 h-2.5 text-indigo-500" />
      </div>
      <span className="font-medium tracking-wide">{statusText}</span>
    </div>
  );
};
