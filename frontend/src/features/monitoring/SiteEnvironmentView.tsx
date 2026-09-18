import React from 'react';
import type { SiteEnvironmentArtifact } from './types';

const SiteEnvironmentCard = React.lazy(() =>
  import('./SiteEnvironmentCard').then((module) => ({ default: module.SiteEnvironmentCard }))
);

export interface SiteEnvironmentViewProps {
  environment: SiteEnvironmentArtifact;
}

export const SiteEnvironmentView: React.FC<SiteEnvironmentViewProps> = React.memo(({ environment }) => {
  return (
    <React.Suspense
      fallback={
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500">
          正在加载地图组件…
        </div>
      }
    >
      <SiteEnvironmentCard environment={environment} />
    </React.Suspense>
  );
});
SiteEnvironmentView.displayName = 'SiteEnvironmentView';
