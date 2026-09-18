import React from 'react';

export const EmptyOrGenericResultView: React.FC = React.memo(() => {
  return (
    <div className="rounded-lg border border-neutral-200/80 bg-neutral-50 p-3 text-xs text-neutral-500">
      该步骤没有可展示的业务数据
    </div>
  );
});
EmptyOrGenericResultView.displayName = 'EmptyOrGenericResultView';
