import { useEffect, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { useLmaClient } from './LmaClientContext';
import type { InvestigationRecord } from '@/services/api';

const statusLabels: Record<string, string> = {
  running: '进行中',
  paused: '待继续',
  completed: '已完成',
  interrupted: '已中断',
  cancelled: '已停止',
  error: '执行失败',
};

const outcomeLabels: Record<string, string> = {
  pending: '待调查', answered: '已回答', insufficient: '证据不足', blocked: '外部阻塞', withdrawn: '已撤回',
};

export function InvestigationRecords() {
  const client = useLmaClient();
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const id = useAuiState((state) => state.threads.threadItems.find(
    (item) => item.id === state.threads.mainThreadId,
  )?.remoteId);
  const [records, setRecords] = useState<InvestigationRecord[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setRecords([]);
    setError('');
    if (id && !running) {
      client.listInvestigations(id, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setRecords(result);
        }
      }).catch(() => {
        if (!controller.signal.aborted) {
          setError('调查记录暂未载入。');
        }
      });
    }
    return () => controller.abort();
  }, [client, id, running, retry]);

  const continueInvestigation = (investigationId: string) => {
    aui.thread().append({
      role: 'user',
      content: [{
        type: 'text',
        text: '继续调查',
      }],
      runConfig: { custom: { resumeInvestigationId: investigationId } },
    });
  };

  if (error) {
    return (
      <div className="mb-4 text-sm">
        <p role="alert">{error}</p>
        <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>
          重新载入调查记录
        </button>
      </div>
    );
  }
  if (!records.length) return null;

  return (
    <details className="mb-4 rounded border p-3 text-sm wrap-break-word">
      <summary>调查进度</summary>
      {records.map((record) => {
        return (
          <div key={record.id} className="my-3 space-y-2">
            <p>{record.progress.goal} · {statusLabels[record.status] ?? '状态未知'}</p>
            <p>{record.progress.stage_conclusion}</p>
            <p>已覆盖：{record.progress.covered.length} / {record.progress.targets.length} 项</p>
            <ul>
              {record.progress.targets.map((target) => (
                <li key={target.target_id}>
                  {outcomeLabels[target.outcome] ?? '待调查'}：{target.question}（{target.begin_time} 至 {target.end_time}）
                  {target.result && <p className="text-muted-foreground">{target.result}</p>}
                </li>
              ))}
            </ul>
            {record.progress.unresolved.length > 0 && <p>待解决：{record.progress.unresolved.join('；')}</p>}
            {record.status !== 'completed' && (
              <button type="button" disabled={running} className="underline" onClick={() => continueInvestigation(record.id)}>
                继续调查
              </button>
            )}
          </div>
        );
      })}
    </details>
  );
}
