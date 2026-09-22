import React from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { SiteEnvironmentArtifactData } from '@/types/envelope';

const SiteEnvironmentCard = React.lazy(() =>
  import('@/components/SiteEnvironmentCard').then((module) => ({ default: module.SiteEnvironmentCard }))
);

export interface SiteEnvironmentResultViewProps {
  environment: SiteEnvironmentArtifactData;
  limitations?: string[];
}

export const SiteEnvironmentResultView: React.FC<SiteEnvironmentResultViewProps> = ({
  environment,
  limitations,
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
        <SiteEnvironmentCard environment={environment} limitations={limitations} />
      </React.Suspense>
    </ErrorBoundary>
  );
};

export const SiteEnvironmentResult = SiteEnvironmentResultView;
