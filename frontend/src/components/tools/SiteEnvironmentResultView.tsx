import React from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import type { SiteEnvironmentArtifact } from '../toolArtifacts';

const SiteEnvironmentCard = React.lazy(() =>
  import('../SiteEnvironmentCard').then((module) => ({ default: module.SiteEnvironmentCard }))
);

interface SiteEnvironmentResultViewProps {
  environment: SiteEnvironmentArtifact;
}

export const SiteEnvironmentResultView: React.FC<SiteEnvironmentResultViewProps> = ({
  environment,
}) => {
  return (
    <ErrorBoundary fallbackTitle="现场环境地图渲染异常">
      <React.Suspense
        fallback={
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500">
            正在加载地图组件…
          </div>
        }
      >
        <SiteEnvironmentCard environment={environment} />
      </React.Suspense>
    </ErrorBoundary>
  );
};
