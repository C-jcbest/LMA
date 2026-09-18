import React from 'react';
import { Sparkles, ChevronRight } from 'lucide-react';
import { ThreadPrimitive } from '@assistant-ui/react';
import { useLmaRecommendations } from '../../agent/runtime';

export interface RecommendationsProps {
  onSelectAction?: (action: string) => void;
  disabled?: boolean;
}

export const Recommendations: React.FC<RecommendationsProps> = ({
  onSelectAction,
  disabled = false,
}) => {
  const recommendations = useLmaRecommendations();

  if (!recommendations || recommendations.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-4xl mx-auto py-2 px-1">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-neutral-400 font-medium">
        <Sparkles className="w-3 h-3 text-indigo-500" />
        <span>建议后续追问</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {recommendations.map((rec, index) => (
          <ThreadPrimitive.Suggestion
            key={index}
            prompt={rec}
            autoSend={true}
            method="replace"
            asChild
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelectAction?.(rec)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-neutral-200 bg-white hover:bg-neutral-50 text-xs text-neutral-700 hover:text-neutral-900 transition-colors shadow-2xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-left max-w-md truncate"
            >
              <span className="truncate">{rec}</span>
              <ChevronRight className="w-3 h-3 text-neutral-400 shrink-0" />
            </button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};
