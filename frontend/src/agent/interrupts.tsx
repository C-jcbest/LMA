import React, { useState } from 'react';
import {
  useLangChainInterrupts,
  useLangChainRespond,
  useLangChainRespondAll,
} from '@assistant-ui/react-langchain';
import { HelpCircle, Check, X, Send, MapPin, Calendar } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

export type InterruptType = 'confirmation' | 'station_selection' | 'time_range' | 'free_text' | 'generic';

export interface BaseInterruptPayload {
  type?: InterruptType;
  message?: string;
  options?: string[];
  stations?: string[];
  ranges?: string[];
  [key: string]: any;
}

function resolveInterruptType(payload: unknown): InterruptType {
  if (!payload || typeof payload !== 'object') return 'confirmation';
  const val = payload as BaseInterruptPayload;
  if (val.type) return val.type;
  if (Array.isArray(val.stations) && val.stations.length > 0) return 'station_selection';
  if (Array.isArray(val.ranges) && val.ranges.length > 0) return 'time_range';
  if (Array.isArray(val.options) && val.options.length > 0) return 'station_selection';
  if (typeof val.message === 'string' && !val.options) return 'confirmation';
  return 'generic';
}

interface SingleInterruptItemProps {
  id: string;
  value: unknown;
  onRespond?: (response: unknown) => void;
  onValueChange?: (id: string, value: unknown) => void;
  currentValue?: unknown;
  isParallel?: boolean;
}

const SingleInterruptItem: React.FC<SingleInterruptItemProps> = ({
  id,
  value,
  onRespond,
  onValueChange,
  currentValue,
  isParallel = false,
}) => {
  const [localInput, setLocalInput] = useState('');
  const val: any = value;
  const interruptType = resolveInterruptType(val);

  const message =
    typeof val === 'string'
      ? val
      : typeof val?.message === 'string'
      ? val.message
      : '智能体请求您确认或提供进一步指示以继续：';

  const handleSelect = (choice: unknown) => {
    if (isParallel) {
      onValueChange?.(id, choice);
    } else {
      onRespond?.(choice);
    }
  };

  return (
    <div className="space-y-2 border-b border-indigo-100/60 pb-3 last:border-b-0 last:pb-0">
      <div className="text-xs text-neutral-800 font-medium leading-relaxed">{message}</div>

      {interruptType === 'station_selection' && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {((val?.stations || val?.options) as string[])?.map((st, i) => {
            const isSelected = currentValue === st;
            return (
              <Button
                key={i}
                type="button"
                size="sm"
                variant={isSelected ? 'default' : 'outline'}
                onClick={() => handleSelect(st)}
                className={`text-xs gap-1 h-7 ${
                  isSelected ? 'bg-indigo-600 text-white' : 'bg-white hover:bg-neutral-50'
                }`}
              >
                <MapPin className="w-3 h-3 text-indigo-500" />
                <span>{st}</span>
              </Button>
            );
          })}
        </div>
      )}

      {interruptType === 'time_range' && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {((val?.ranges || val?.options) as string[])?.map((rg, i) => {
            const isSelected = currentValue === rg;
            return (
              <Button
                key={i}
                type="button"
                size="sm"
                variant={isSelected ? 'default' : 'outline'}
                onClick={() => handleSelect(rg)}
                className={`text-xs gap-1 h-7 ${
                  isSelected ? 'bg-indigo-600 text-white' : 'bg-white hover:bg-neutral-50'
                }`}
              >
                <Calendar className="w-3 h-3 text-indigo-500" />
                <span>{rg}</span>
              </Button>
            );
          })}
        </div>
      )}

      {interruptType === 'free_text' && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={localInput}
            onChange={(e) => {
              setLocalInput(e.target.value);
              if (isParallel) onValueChange?.(id, e.target.value);
            }}
            placeholder={val?.placeholder || '输入指令或参数…'}
            className="h-7 text-xs bg-white"
          />
          {!isParallel && (
            <Button
              type="button"
              size="sm"
              onClick={() => handleSelect(localInput)}
              disabled={!localInput.trim()}
              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 text-white gap-1"
            >
              <Send className="w-3 h-3" />
              <span>提交</span>
            </Button>
          )}
        </div>
      )}

      {(interruptType === 'confirmation' || interruptType === 'generic') && (
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => handleSelect(true)}
            className={`text-xs h-7 gap-1 ${
              currentValue === true
                ? 'bg-emerald-600 text-white'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            <Check className="w-3.5 h-3.5" />
            <span>{val?.confirmLabel || '确认继续'}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => handleSelect(false)}
            className={`text-xs h-7 gap-1 bg-white hover:bg-neutral-50 ${
              currentValue === false ? 'border-red-500 text-red-600' : ''
            }`}
          >
            <X className="w-3.5 h-3.5" />
            <span>{val?.cancelLabel || '取消终止'}</span>
          </Button>
        </div>
      )}
    </div>
  );
};

export const InterruptHandler: React.FC = () => {
  const interrupts = useLangChainInterrupts();
  const respond = useLangChainRespond();
  const respondAll = useLangChainRespondAll();

  // 用于并行中断时暂存每个 ID 的应答值
  const [parallelResponses, setParallelResponses] = useState<Record<string, unknown>>({});

  if (!interrupts || interrupts.length === 0) {
    return null;
  }

  const isParallel = interrupts.length > 1;

  // 单中断模式：立即提交
  const handleSingleRespond = async (responseValue: unknown) => {
    try {
      await respond(responseValue);
    } catch (e) {
      console.error('Failed to respond to LangGraph interrupt:', e);
    }
  };

  // 并行中断模式：更新暂存值
  const handleParallelValueChange = (id: string, value: unknown) => {
    setParallelResponses((prev) => ({ ...prev, [id]: value }));
  };

  // 并行中断模式：使用 respondAll 批量提交，避免第一条启动新 Run 遗漏后续中断
  const handleParallelSubmitAll = async () => {
    try {
      await respondAll(parallelResponses);
    } catch (e) {
      console.error('Failed to respondAll to LangGraph interrupts:', e);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto my-3 p-4 rounded-xl border border-indigo-200 bg-indigo-50/50 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-indigo-100 text-indigo-700 shrink-0 mt-0.5">
          <HelpCircle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-800">
              人工介入确认 (Human-in-the-Loop)
            </span>
            {isParallel && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                {interrupts.length} 项并行确认
              </span>
            )}
          </div>

          <div className="space-y-3">
            {interrupts.map((interrupt, index) => {
              const id = interrupt.id || `interrupt-${index}`;
              return (
                <SingleInterruptItem
                  key={id}
                  id={id}
                  value={interrupt.value}
                  onRespond={handleSingleRespond}
                  onValueChange={handleParallelValueChange}
                  currentValue={parallelResponses[id]}
                  isParallel={isParallel}
                />
              );
            })}
          </div>

          {isParallel && (
            <div className="pt-2 flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={handleParallelSubmitAll}
                className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>批量提交全部确认</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
