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
      client.listInvestigations(id, controller.signal).then(setRecords).catch(() => {
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
        text: '请续查调查 ' + investigationId + '，读取原调查和证据，核查新鲜度，只处理待解决问题。已覆盖对象不重复查询，当前问题需要刷新时说明理由并保留旧证据。',
      }],
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
        const remaining = record.progress.targets.filter((target) => !record.progress.covered.includes(target.target_id));
        return (
          <div key={record.id} className="my-3 space-y-2">
            <p>{record.progress.goal} · {statusLabels[record.status] ?? '状态未知'}</p>
            <p>{record.progress.stage_conclusion}</p>
            <p>已覆盖：{record.progress.covered.length} / {record.progress.targets.length} 项</p>
            <ul>
              {remaining.map((target) => (
                <li key={target.target_id}>待调查：{target.question}（{target.begin_time} 至 {target.end_time}）</li>
              ))}
            </ul>
            <p>待解决：{record.progress.unresolved.join('；') || '尚未记录'}</p>
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
