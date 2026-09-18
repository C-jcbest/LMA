import React from 'react';
import { useLangChainInterrupts, useLangChainRespond } from '@assistant-ui/react-langchain';
import { HelpCircle, Check, X } from 'lucide-react';
import { Button } from '../components/ui/button';

export const InterruptHandler: React.FC = () => {
  const interrupts = useLangChainInterrupts();
  const respond = useLangChainRespond();

  if (!interrupts || interrupts.length === 0) {
    return null;
  }

  // 取当前最新的待响应中断
  const currentInterrupt = interrupts[0];
  const val: any = currentInterrupt.value;

  const handleRespond = async (responseValue: any) => {
    try {
      await respond(responseValue);
    } catch (e) {
      console.error('Failed to respond to LangGraph interrupt:', e);
    }
  };

  // 如果值包含文本消息或提示
  const message =
    typeof val === 'string'
      ? val
      : typeof val?.message === 'string'
      ? val.message
      : '智能体请求您确认或提供进一步指示以继续：';

  // 预置选项列表（如果后端传入 options）
  const options: string[] = Array.isArray(val?.options) ? val.options : [];

  return (
    <div className="w-full max-w-2xl mx-auto my-3 p-4 rounded-xl border border-indigo-200 bg-indigo-50/50 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-indigo-100 text-indigo-700 shrink-0 mt-0.5">
          <HelpCircle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div className="text-xs font-semibold text-neutral-800">
            人工介入确认 (Human-in-the-Loop)
          </div>
          <div className="text-xs text-neutral-700 leading-relaxed">
            {message}
          </div>

          {options.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {options.map((opt, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant="outline"
                  onClick={() => handleRespond(opt)}
                  className="text-xs bg-white hover:bg-neutral-50"
                >
                  {opt}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => handleRespond(true)}
                className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                <span>确认继续</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRespond(false)}
                className="text-xs gap-1"
              >
                <X className="w-3.5 h-3.5" />
                <span>取消终止</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
