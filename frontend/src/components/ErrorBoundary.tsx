import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, EyeOff, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
          <div className="flex h-full flex-1 flex-col items-center justify-center bg-background p-6 text-foreground">
            <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <AlertCircle className="size-5" aria-hidden />
              </div>
              <div>
                <h3 className="text-sm font-semibold">
                  {this.props.fallbackTitle || '会话界面加载异常'}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  请重新载入页面。
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={this.handleReload}>
                <RefreshCw className="text-muted-foreground" aria-hidden />
                刷新页面
              </Button>
            </div>
          </div>
        );
      }

      return (
        <div className="my-2 rounded-lg border bg-muted/50 p-3 text-xs text-foreground">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{this.props.fallbackTitle || '该内容暂时无法显示'}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="xs" onClick={this.handleReload}>
                <RotateCcw className="text-muted-foreground" aria-hidden />
                重新加载
              </Button>
              <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={this.handleHide}>
                <EyeOff aria-hidden />
                隐藏
              </Button>
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
