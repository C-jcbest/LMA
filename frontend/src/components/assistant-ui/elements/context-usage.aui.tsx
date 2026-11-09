import type { FC } from "react";
import { ContextDisplay } from "@/components/context-display";
import { cn } from "@/lib/utils";

const VISIBLE_USAGE_RATIO = 0.8;

export interface ContextUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  max_input_tokens?: number;
  usage_ratio?: number | null;
  model?: string;
}

export interface ContextUsageElementProps {
  usage?: ContextUsage;
  className?: string;
}

export const ContextUsageElement: FC<ContextUsageElementProps> = ({
  usage,
  className,
}) => {
  const inputTokens = usage?.input_tokens;
  const maxInputTokens = usage?.max_input_tokens;
  const outputTokens = usage?.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof maxInputTokens !== "number" ||
    !Number.isFinite(maxInputTokens) ||
    maxInputTokens <= 0
  ) {
    return null;
  }

  // 历史压缩是自动的，用量只在接近上限、值得用户留意时出现。
  if (inputTokens / maxInputTokens < VISIBLE_USAGE_RATIO) {
    return null;
  }

  return (
    <ContextDisplay.Ring
      modelContextWindow={maxInputTokens}
      usage={{
        totalTokens: inputTokens,
        inputTokens,
        outputTokens,
      }}
      side="top"
      className={cn("size-5 p-0 [&>span]:hidden", className)}
    />
  );
};
