import React from 'react';

interface ThinkingIndicatorProps {
  statusText?: string;
}

export const WaveDots: React.FC<{ className?: string; dotClassName?: string }> = ({
  className = '',
  dotClassName = 'bg-neutral-400',
}) => {
  return (
    <span className={`inline-flex items-center gap-1 py-0.5 align-middle select-none ${className}`} aria-hidden="true">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClassName} animate-bounce [animation-delay:-0.3s]`} />
      <span className={`w-1.5 h-1.5 rounded-full ${dotClassName} animate-bounce [animation-delay:-0.15s]`} />
      <span className={`w-1.5 h-1.5 rounded-full ${dotClassName} animate-bounce`} />
    </span>
  );
};

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  statusText = '智能体正在检索北斗平台与分析监测数据...',
}) => {
  return (
    <div className="flex items-center gap-2.5 text-xs text-neutral-500 py-1.5 select-none">
      <WaveDots />
      <span className="font-medium tracking-wide text-neutral-600">{statusText}</span>
    </div>
  );
};
