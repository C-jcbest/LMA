import type { FC } from 'react';
import type { ComputationArtifactData } from '@/types/envelope';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatCell = (value: unknown) => {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const Table: FC<{ columns: string[]; rows: unknown[][]; total?: number }> = ({ columns, rows, total }) => (
  <div className="max-h-80 overflow-auto rounded-md border">
    <table className="w-full text-sm tabular-nums">
      <thead className="sticky top-0 bg-muted text-muted-foreground">
        <tr>{columns.map((column) => <th key={column} scope="col" className="px-3 py-1.5 text-start font-normal">{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-t">
            {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-1.5">{formatCell(cell)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
    {total !== undefined && total > rows.length && (
      <p className="px-3 py-1.5 text-xs text-muted-foreground">共 {total} 行，仅显示前 {rows.length} 行</p>
    )}
  </div>
);

/** 计算结果按形状展示：表格、序列、键值或单个数值；不展示内部字段名之外的技术细节。 */
const ResultValue: FC<{ value: unknown }> = ({ value }) => {
  if (isRecord(value) && value.type === 'table' && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return <Table columns={value.columns.map(String)} rows={value.rows as unknown[][]} total={Number(value.row_count)} />;
  }
  if (isRecord(value) && value.type === 'series' && Array.isArray(value.index) && Array.isArray(value.values)) {
    const values = value.values;
    return (
      <Table
        columns={['', value.name ? String(value.name) : '值']}
        rows={value.index.map((key, index) => [key, values[index]])}
        total={Number(value.row_count)}
      />
    );
  }
  if (isRecord(value)) {
    return <Table columns={['项目', '值']} rows={Object.entries(value)} />;
  }
  if (Array.isArray(value)) {
    return <Table columns={['值']} rows={value.map((item) => [item])} />;
  }
  return <p className="text-base font-medium tabular-nums">{formatCell(value)}</p>;
};

export const ComputationResultView: FC<{ data: ComputationArtifactData }> = ({ data }) => (
  <div className="space-y-2 text-sm">
    <ResultValue value={data.result} />
    {data.truncated && <p className="text-xs text-muted-foreground">结果较长，已截取前 200 行。</p>}
    {/* 计算代码保存在依据里供复核，按产品约定不向业务人员展示代码。 */}
    <p className="text-xs text-muted-foreground">数据：{data.inputs.map((input) => input.description).join('；')}</p>
  </div>
);
