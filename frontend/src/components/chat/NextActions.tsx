import React from 'react';
import { ChevronRight } from 'lucide-react';

interface NextActionsProps {
  recommendations: string[];
  onSelectAction: (action: string) => void;
  disabled?: boolean;
}

export const NextActions: React.FC<NextActionsProps> = ({
  recommendations,
  onSelectAction,
  disabled = false,
}) => {
  if (!recommendations.length || disabled) return null;

  return (
    <div className="max-w-4xl mx-auto w-full flex flex-wrap items-center gap-2 pl-11">
      <span className="text-[11px] text-neutral-400 select-none shrink-0">下一步</span>
      {recommendations.map((rec, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelectAction(rec)}
          className="flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full border border-neutral-200 bg-white text-xs text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 transition-colors shadow-xs cursor-pointer"
        >
          <ChevronRight className="w-3 h-3 text-indigo-500 shrink-0" />
          <span className="truncate">{rec}</span>
        </button>
      ))}
    </div>
  );
};
