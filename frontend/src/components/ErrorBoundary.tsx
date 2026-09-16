import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, EyeOff, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  level?: 'window' | 'component';
  onReload?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  hidden: boolean;
  remountKey: number;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    hidden: false,
    remountKey: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 内部异常只写日志，不直接向用户展示技术诊断与 stack trace
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  private handleReload = () => {
    if (this.props.level === 'window') {
      window.location.reload();
    } else {
      this.props.onReload?.();
      this.setState((prev) => ({
        hasError: false,
        error: null,
        remountKey: prev.remountKey + 1,
      }));
    }
  };

  private handleHide = () => {
    this.setState({ hidden: true });
  };

  public render() {
    if (this.state.hidden) {
      return null;
    }

    if (this.state.hasError) {
      const isWindow = this.props.level === 'window';

      if (isWindow) {
        return (
          <div className="flex-1 h-full flex flex-col items-center justify-center p-6 bg-white text-neutral-800">
            <div className="max-w-md w-full rounded-2xl border border-red-200/80 bg-red-50/50 p-6 text-center shadow-sm space-y-4">
              <div className="w-10 h-10 mx-auto rounded-xl bg-red-100/80 flex items-center justify-center text-red-600">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">
                  {this.props.fallbackTitle || '会话界面加载异常'}
                </h3>
                <p className="mt-1 text-xs text-neutral-500">
                  界面渲染发生不可恢复的错误，请尝试刷新页面。
                </p>
              </div>
              <button
                type="button"
                onClick={this.handleReload}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-neutral-200 text-xs font-medium text-neutral-800 hover:bg-neutral-50 shadow-xs transition-all active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5 text-neutral-500" />
                <span>刷新页面</span>
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="my-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-neutral-400 shrink-0" />
              <span>{this.props.fallbackTitle || '该内容暂时无法显示'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-neutral-200 text-[11px] font-medium text-neutral-700 hover:bg-neutral-100 transition-colors"
              >
                <RotateCcw className="w-3 h-3 text-neutral-500" />
                <span>重新加载</span>
              </button>
              <button
                type="button"
                onClick={this.handleHide}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-neutral-700 transition-colors"
              >
                <EyeOff className="w-3 h-3" />
                <span>隐藏</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <React.Fragment key={this.state.remountKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
