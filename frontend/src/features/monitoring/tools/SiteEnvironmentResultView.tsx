import React from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { SiteEnvironmentArtifactData } from '@/types/envelope';

const SiteEnvironmentCard = React.lazy(() =>
  import('./SiteEnvironmentCard').then((module) => ({ default: module.SiteEnvironmentCard }))
);

export interface SiteEnvironmentResultViewProps {
  environment: SiteEnvironmentArtifactData;
}

export const SiteEnvironmentResultView: React.FC<SiteEnvironmentResultViewProps> = ({
  environment,
}) => {
  return (
    <ErrorBoundary fallbackTitle="现场环境地图渲染异常">
      <React.Suspense fallback={<p className="text-sm text-muted-foreground">正在加载地图…</p>}>
        <SiteEnvironmentCard environment={environment} />
      </React.Suspense>
    </ErrorBoundary>
  );
};
