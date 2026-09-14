import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="my-2 rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 shadow-sm">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
            <span>{this.props.fallbackTitle || '组件加载或渲染异常'}</span>
          </div>
          <div className="mt-1 text-red-600 font-mono text-[11px] break-all">
            {this.state.error?.message || '未知运行时错误'}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2.5 rounded-md bg-red-100 px-3 py-1 text-[11px] font-medium text-red-800 hover:bg-red-200 transition-colors"
          >
            重试恢复
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
