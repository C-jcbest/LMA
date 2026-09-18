export type AppErrorScope = 'run' | 'thread' | 'tool' | 'connection';

export interface AppError {
  scope: AppErrorScope;
  code: string;
  message: string;
  retryable: boolean;
  category?: string;
  details?: unknown;
}

export function createAppError(
  scope: AppErrorScope,
  message: string,
  options?: Partial<Omit<AppError, 'scope' | 'message'>>
): AppError {
  return {
    scope,
    code: options?.code || 'UNKNOWN_ERROR',
    message,
    retryable: options?.retryable ?? false,
    category: options?.category,
    details: options?.details,
  };
}
