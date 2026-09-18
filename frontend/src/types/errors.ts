/**
 * 统一错误模型 (AppError)
 */

export type AppErrorScope = 'message' | 'run' | 'thread' | 'tool' | 'connection';

export type AppError =
  | {
      scope: 'message';
      code: string;
      message: string;
      retryable: boolean;
      messageId?: string;
    }
  | {
      scope: 'run';
      code: string;
      message: string;
      retryable: boolean;
      runId?: string;
      threadId?: string;
    }
  | {
      scope: 'thread';
      code: string;
      message: string;
      retryable: boolean;
      threadId?: string;
    }
  | {
      scope: 'tool';
      code: string;
      message: string;
      retryable: boolean;
      toolCallId?: string;
      toolName?: string;
    }
  | {
      scope: 'connection';
      code: string;
      message: string;
      retryable: boolean;
      status?: 'reconnecting' | 'recovered' | 'unavailable';
    };

export interface ErrorDisplayOptions {
  severity: 'warning' | 'error';
  title?: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  safeDetail?: string;
}
