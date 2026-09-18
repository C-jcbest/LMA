import React from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { TOOL_KIND_MAP } from '../../agent/toolResultAdapter';
import { ToolCardContainer } from '../../agent/toolkit';
import { EmptyOrGenericResultView } from '../../features/monitoring/EmptyOrGenericResultView';

export const ToolFallback: React.FC<ToolCallMessagePartProps> = (props) => {
  const meta = TOOL_KIND_MAP[props.toolName] || {
    label: props.toolName || '工具查询',
    kind: 'generic',
    defaultExpanded: false,
  };

  return (
    <ToolCardContainer
      label={meta.label}
      toolName={props.toolName}
      args={props.args}
      result={props.result}
      artifact={(props as any).artifact}
      status={props.status}
      isError={(props as any).isError}
      defaultExpanded={Boolean(meta.defaultExpanded)}
    >
      {({ envelope }) => <EmptyOrGenericResultView envelope={envelope} />}
    </ToolCardContainer>
  );
};
