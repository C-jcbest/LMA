import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Server, CheckCircle2, AlertTriangle, RefreshCw, Lock } from 'lucide-react';
import { getStoredApiUrl, setStoredApiUrl, createLangGraphClient, LMA_ASSISTANT_ID } from '../services/api';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const ConfigModal: React.FC<ConfigModalProps> = ({ isOpen, onClose, onSaved }) => {
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl());
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const isProduction = import.meta.env.PROD;

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMsg('正在连接 LangGraph 服务...');
    try {
      const client = createLangGraphClient(apiUrl.trim());
      const assistant = await client.assistants.get(LMA_ASSISTANT_ID);
      if (assistant.assistant_id !== LMA_ASSISTANT_ID && assistant.graph_id !== LMA_ASSISTANT_ID) {
        throw new Error('目标 Assistant 标识不匹配');
      }
      setTestStatus('success');
      setTestMsg('连接成功，已验证 lma-agent Assistant 可用。');
    } catch (e: any) {
      setTestStatus('error');
      setTestMsg(`连接失败: ${e?.message || '请检查服务地址与目标 Assistant 配置'}`);
    }
  };

  const handleSave = () => {
    if (!isProduction) {
      setStoredApiUrl(apiUrl.trim());
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 animate-in fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-neutral-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-150 focus:outline-none">
          {/* Header */}
          <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-600" />
              <Dialog.Title className="font-semibold text-sm text-neutral-800">
                LangGraph 服务对接配置
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700 cursor-pointer"
                aria-label="关闭对话框"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="sr-only">
            配置与测试后端 LangGraph Agent Server 的连接地址
          </Dialog.Description>

          {/* Body */}
          <div className="p-5 space-y-4 text-xs">
            <div>
              <label className="block font-medium text-neutral-700 mb-1.5">
                LangGraph API 地址 (API URL)
              </label>
              {isProduction ? (
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-neutral-50 border border-neutral-200 text-neutral-500">
                  <Lock className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                  <span className="font-mono text-xs truncate">已由系统安全托管（生产同源连接）</span>
                </div>
              ) : (
                <input
                  type="text"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="请输入 LangGraph API 地址或 /langgraph-api"
                  className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-neutral-800 outline-none focus:border-indigo-500 font-mono text-xs"
                />
              )}
              <p className="text-[11px] text-neutral-400 mt-1">
                {isProduction
                  ? '生产模式已锁定服务端 API 端点与鉴权通道，防止凭证与通信地址越权配置。'
                  : '测试时会同时验证服务连通性与目标 Assistant。'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testStatus === 'testing'}
                className="px-3 py-1.5 rounded-lg border border-neutral-200 hover:bg-neutral-50 text-neutral-700 font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${testStatus === 'testing' ? 'animate-spin' : ''}`} />
                <span>测试连通性</span>
              </button>
            </div>

            {testStatus === 'success' && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{testMsg}</span>
              </div>
            )}

            {testStatus === 'error' && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{testMsg}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 bg-neutral-50 border-t border-neutral-100 flex items-center justify-end gap-2 text-xs">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-3.5 py-1.5 rounded-xl text-neutral-600 hover:bg-neutral-200/60 font-medium transition-colors cursor-pointer"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-1.5 rounded-xl bg-neutral-900 text-white font-medium hover:bg-neutral-800 transition-colors shadow-xs cursor-pointer"
            >
              保存并应用
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
