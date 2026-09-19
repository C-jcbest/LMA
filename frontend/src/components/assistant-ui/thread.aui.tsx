import React from 'react';
import {
  ThreadPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
} from '@assistant-ui/react';
import {
  Activity,
  ArrowDown,
  Copy,
  RotateCw,
  Sparkles,
  Layers,
  CloudRain,
  Radio,
} from 'lucide-react';
import { Button } from '../ui/button';
import { MarkdownText } from './markdown-text.aui';
import { Reasoning } from './reasoning.aui';
import { ToolFallback } from './tool-fallback.aui';

export const UserMessage: React.FC = () => {
  return (
    <MessagePrimitive.Root className="group max-w-4xl mx-auto w-full my-3.5 px-1 sm:px-0">
      <div className="flex items-start gap-3.5 flex-row-reverse">
        {/* 用户头像 ME */}
        <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200/80 flex items-center justify-center shrink-0 text-xs font-semibold text-neutral-700 select-none shadow-2xs">
          ME
        </div>

        {/* 气泡主体 */}
        <div className="min-w-0 flex flex-col max-w-[78%] items-end">
          <div className="rounded-2xl rounded-tr-xs bg-[#f3f4f6] border border-neutral-200/60 px-4 py-2.5 text-sm text-neutral-800 leading-relaxed break-words shadow-xs">
            <MessagePrimitive.Content />
          </div>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

export const AssistantMessage: React.FC = () => {
  return (
    <MessagePrimitive.Root className="group max-w-4xl mx-auto w-full my-4 px-1 sm:px-0">
      <div className="flex items-start gap-3.5 flex-row">
        {/* AI 头像 */}
        <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 text-xs font-bold text-white select-none shadow-xs mt-0.5">
          AI
        </div>

        {/* 回答主体 */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="w-full text-neutral-800 text-sm py-0.5">
            <MessagePrimitive.Content
              components={{
                Text: MarkdownText,
                Reasoning: Reasoning,
                tools: {
                  Fallback: ToolFallback,
                },
              }}
            />
          </div>

          {/* 悬停操作条 */}
          <ActionBarPrimitive.Root className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity pt-1">
            <ActionBarPrimitive.Copy asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 cursor-pointer"
                title="复制回复"
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </ActionBarPrimitive.Copy>

            <ActionBarPrimitive.Reload asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 cursor-pointer"
                title="重新生成"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </Button>
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

export interface ThreadEmptyProps {
  onSelectPrompt?: (prompt: string) => void;
}

const STARTER_PROMPTS = [
  {
    icon: Layers,
    title: '查询监测站位移',
    desc: '获取 SCWM-04 最近 3 天 GNSS 监测数据与趋势',
    prompt: '请查询 SCWM-04 最近 3 天的 GNSS 监测数据并分析位移趋势。',
  },
  {
    icon: CloudRain,
    title: '滑坡区域气象实况',
    desc: '获取当前滑坡现场气象与未来降雨预测',
    prompt: '请查询滑坡现场当前气象与未来降雨预测，并分析降雨对坡体稳定性的潜在影响。',
  },
  {
    icon: Radio,
    title: '监测站通信状态',
    desc: '检查全部在网监测站健康与通信状况',
    prompt: '请检查当前所有监测站的在网状态与健康情况。',
  },
  {
    icon: Sparkles,
    title: '综合险情研判',
    desc: '综合多源监测数据提供滑坡风险研判',
    prompt: '请结合近期位移速率与降雨记录，给出当前滑坡体的综合险情研判。',
  },
];

export const ThreadEmpty: React.FC<ThreadEmptyProps> = ({ onSelectPrompt }) => {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center max-w-2xl mx-auto">
      <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 mb-4 shadow-2xs">
        <Activity className="w-6 h-6" />
      </div>

      <h2 className="text-xl font-semibold text-neutral-800 mb-2 tracking-tight">
        LMA 滑坡连续监测智能体
      </h2>
      <p className="text-sm text-neutral-500 max-w-md leading-relaxed mb-8">
        专业地质灾害多源监测与分析平台。支持 GNSS 位移分析、气象降雨联动、现场视觉核查与综合趋势研判。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full text-left">
        {STARTER_PROMPTS.map((item, idx) => {
          const Icon = item.icon;
          return (
            <ThreadPrimitive.Suggestion
              key={idx}
              prompt={item.prompt}
              autoSend={true}
              method="replace"
              asChild
            >
              <button
                type="button"
                onClick={() => onSelectPrompt?.(item.prompt)}
                className="flex items-start gap-3 p-3.5 rounded-xl border border-neutral-200/80 bg-white hover:bg-neutral-50/80 hover:border-neutral-300 transition-all text-left group cursor-pointer shadow-2xs"
              >
                <div className="p-2 rounded-lg bg-neutral-100 text-neutral-600 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-neutral-800 group-hover:text-indigo-600 transition-colors">
                    {item.title}
                  </div>
                  <div className="text-[11px] text-neutral-500 truncate mt-0.5">
                    {item.desc}
                  </div>
                </div>
              </button>
            </ThreadPrimitive.Suggestion>
          );
        })}
      </div>
    </div>
  );
};

export interface ThreadProps {
  onSelectPrompt?: (prompt: string) => void;
  children?: React.ReactNode;
}

export const Thread: React.FC<ThreadProps> = ({ onSelectPrompt, children }) => {
  return (
    <ThreadPrimitive.Root className="relative flex flex-col h-full bg-white overflow-hidden">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-4 scroll-smooth">
        <ThreadPrimitive.Empty>
          <ThreadEmpty onSelectPrompt={onSelectPrompt} />
        </ThreadPrimitive.Empty>

        <div className="max-w-4xl mx-auto w-full space-y-4">
          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />

          {children}
        </div>
      </ThreadPrimitive.Viewport>

      <ThreadPrimitive.ScrollToBottom asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="absolute bottom-5 right-6 h-8 w-8 rounded-full bg-white/95 shadow-md border border-neutral-200 text-neutral-600 hover:text-neutral-900 transition-transform active:scale-95 z-20 cursor-pointer"
          title="回到底部"
        >
          <ArrowDown className="w-4 h-4" />
        </Button>
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  );
};
