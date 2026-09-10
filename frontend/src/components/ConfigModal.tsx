import React, { useState } from 'react';
import { X, Server, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { getStoredApiUrl, setStoredApiUrl, createLangGraphClient } from '../services/api';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const ConfigModal: React.FC<ConfigModalProps> = ({ isOpen, onClose, onSaved }) => {
  const [apiUrl, setApiUrl] = useState(getStoredApiUrl());
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMsg('正在连接 LangGraph 服务...');
    try {
      const client = createLangGraphClient(apiUrl.trim());
      // 尝试调用 assistants.search 或 threads.search
      const res = await client.assistants.search({ limit: 5 });
      setTestStatus('success');
      setTestMsg(`连接成功！发现 ${res?.length || 0} 个注册的 Assistant 图 (包含 lma-agent)`);
    } catch (e: any) {
      setTestStatus('error');
      setTestMsg(`连接失败: ${e?.message || '请确保 langgraph dev 已在指定端口运行'}`);
    }
  };

  const handleSave = () => {
    setStoredApiUrl(apiUrl.trim());
    onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-neutral-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-indigo-600" />
            <h3 className="font-semibold text-sm text-neutral-800">LangGraph 服务对接配置</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          <div>
            <label className="block font-medium text-neutral-700 mb-1.5">
              LangGraph API 地址 (API URL)
            </label>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://localhost:2024 或 /langgraph-api"
              className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-neutral-800 outline-none focus:border-indigo-500 font-mono text-xs"
            />
            <p className="text-[11px] text-neutral-400 mt-1">
              后端启动命令：<code>langgraph dev --port 2024 --no-browser</code>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testStatus === 'testing'}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 hover:bg-neutral-50 text-neutral-700 font-medium flex items-center gap-1.5 transition-colors"
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
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl text-neutral-600 hover:bg-neutral-200/60 font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-xl bg-neutral-900 text-white font-medium hover:bg-neutral-800 transition-colors shadow-sm"
          >
            保存并应用
          </button>
        </div>
      </div>
    </div>
  );
};
