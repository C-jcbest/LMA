import React from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '../ui/button';

export interface ComposerProps {
  disabled?: boolean;
  placeholder?: string;
}

export const Composer: React.FC<ComposerProps> = ({
  disabled = false,
  placeholder = '输入滑坡监测指令或问题，例如：查询 SCWM-04 最近 3 天位移变化…',
}) => {
  return (
    <ComposerPrimitive.Root className="relative w-full rounded-2xl border border-neutral-300 bg-white p-2.5 shadow-xs transition-all focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100">
      <div className="flex items-end gap-2">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 max-h-36 min-h-[38px] resize-none border-0 bg-transparent px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-hidden leading-relaxed"
        />

        <div className="flex items-center gap-1 shrink-0 pb-0.5">
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-full border-neutral-300 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 transition-colors"
                title="停止生成"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>

          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <Button
                type="button"
                size="icon"
                className="h-8 w-8 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors shadow-2xs"
                title="发送"
              >
                <ArrowUp className="w-4 h-4" />
              </Button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
