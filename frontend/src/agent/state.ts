import type { BaseMessage } from '@langchain/core/messages';

export interface ContextUsage {
  used_tokens?: number;
  max_tokens?: number;
  window_usage_ratio?: number;
  percentage?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_limit_tokens?: number;
  remaining_tokens?: number | null;
  usage_ratio?: number | null;
  counter?: string;
  model?: string;
}


export interface RuntimeStatus {
  stage?: string;
  tool_name?: string;
  tool_count?: number;
  waiting_for_user?: boolean;
}

export interface LmaState {
  messages: BaseMessage[];
  recommendations?: string[];
  context_usage?: ContextUsage;
  runtime_status?: RuntimeStatus;
}
