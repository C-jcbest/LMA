import { FC, useMemo } from "react";
import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { useLangChainState } from "@assistant-ui/react-langchain";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type RecommendationState =
  | string[]
  | {
      recommendations?: string[];
    }
  | null
  | undefined;

const normalizeRecommendations = (state: RecommendationState): string[] => {
  if (!state) return [];
  if (Array.isArray(state)) {
    return state.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (Array.isArray(state.recommendations)) {
    return state.recommendations.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return [];
};

export interface FollowUpSuggestionsProps {
  className?: string;
  onSelect?: (suggestion: string) => void;
}

export const ThreadFollowupSuggestions: FC<{ className?: string }> = ({
  className,
}) => {
  const rawState = useLangChainState<RecommendationState>("recommendations", []);
  const recommendations = useMemo(() => normalizeRecommendations(rawState), [rawState]);

  if (recommendations.length === 0) {
    return null;
  }

  return (
    <AuiIf condition={(s) => !s.thread.isRunning && !s.thread.isEmpty}>
      <div className={cn("flex flex-col gap-2 px-3 pb-2", className)}>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80">
          <Sparkles className="size-3 text-amber-500/80" />
          <span>下一步建议</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {recommendations.map((prompt) => (
            <ThreadPrimitive.Suggestion
              key={prompt}
              className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs text-foreground/80 shadow-2xs backdrop-blur-xs transition-colors hover:border-border hover:bg-muted/80 hover:text-foreground cursor-pointer"
              prompt={prompt}
              send
            >
              {prompt}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </AuiIf>
  );
};

// 保持薄兼容导出
export const FollowUpSuggestions: FC<FollowUpSuggestionsProps> = ({
  className,
}) => <ThreadFollowupSuggestions className={className} />;
