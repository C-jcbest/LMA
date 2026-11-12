import type { FC } from 'react';
import type { ComputationArtifactData } from '@/types/envelope';

type Scalar = string | number | boolean | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** 只含标量的平铺字典，例如一段时间的天数、雨量、最大日雨量。 */
const isFlatRecord = (value: unknown): value is Record<string, Scalar> =>
  isRecord(value) && value.type === undefined && Object.values(value).every(isScalar);

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

const Table: FC<{ columns: string[]; rows: unknown[][]; total?: number; caption?: string }> = ({ columns, rows, total, caption }) => (
  <div className="space-y-1.5">
    {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    <div className="max-h-80 overflow-auto rounded-md border">
      <table className="w-full text-sm tabular-nums">
        <thead className="sticky top-0 bg-muted text-muted-foreground">
          <tr>{columns.map((column, index) => <th key={index} scope="col" className="px-3 py-1.5 text-start font-normal whitespace-nowrap">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={cellIndex === 0 ? 'px-3 py-1.5 text-muted-foreground whitespace-nowrap' : 'px-3 py-1.5'}>
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total !== undefined && Number.isFinite(total) && total > rows.length && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">共 {total} 行，仅显示前 {rows.length} 行</p>
      )}
    </div>
  </div>
);

const Metrics: FC<{ entries: [string, Scalar][] }> = ({ entries }) => (
  <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-3">
    {entries.map(([key, value]) => (
      <div key={key} className="min-w-0">
        <dt className="text-xs text-muted-foreground wrap-break-word">{key}</dt>
        <dd className="text-base font-medium tabular-nums wrap-break-word">{formatCell(value)}</dd>
      </div>
    ))}
  </dl>
);

/** 单个值按形状展示：服务端序列化的表格、序列、平铺字典、数组或数值。 */
const ResultValue: FC<{ value: unknown; caption?: string }> = ({ value, caption }) => {
  if (isRecord(value) && value.type === 'table' && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return <Table caption={caption} columns={value.columns.map(String)} rows={value.rows as unknown[][]} total={Number(value.row_count)} />;
  }
  if (isRecord(value) && value.type === 'series' && Array.isArray(value.index) && Array.isArray(value.values)) {
    const values = value.values;
    return (
      <Table
        caption={caption}
        columns={['', value.name ? String(value.name) : '值']}
        rows={value.index.map((key, index) => [key, values[index]])}
        total={Number(value.row_count)}
      />
    );
  }
  if (isFlatRecord(value)) {
    return <Table caption={caption} columns={['项目', '值']} rows={Object.entries(value)} />;
  }
  if (Array.isArray(value)) {
    return <Table caption={caption} columns={['值']} rows={value.map((item) => [item])} />;
  }
  if (isRecord(value)) {
    return <DictionaryResult value={value} />;
  }
  return (
    <div>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
      <p className="text-base font-medium tabular-nums">{formatCell(value)}</p>
    </div>
  );
};

/**
 * 模型常把结果写成字典：标量作为指标并排，字段相同的几组平铺字典（如前后两段）合成一张对比表，
 * 其余嵌套内容各自成表，避免把 JSON 原文展示给业务人员。
 */
const DictionaryResult: FC<{ value: Record<string, unknown> }> = ({ value }) => {
  const entries = Object.entries(value);
  const scalars = entries.filter((entry): entry is [string, Scalar] => isScalar(entry[1]));
  const flatGroups = entries.filter((entry): entry is [string, Record<string, Scalar>] => isFlatRecord(entry[1]));
  // 字段完全相同的几组才合成对比表；字段不同的（如逐日雨量）各自成表。
  const fieldsOf = (group: Record<string, Scalar>) => Object.keys(group).sort().join('\u0000');
  const groupsByFields = new Map<string, [string, Record<string, Scalar>][]>();
  for (const entry of flatGroups) {
    groupsByFields.set(fieldsOf(entry[1]), [...(groupsByFields.get(fieldsOf(entry[1])) ?? []), entry]);
  }
  const comparison = [...groupsByFields.values()]
    .filter((groups) => groups.length >= 2)
    .sort((a, b) => b.length - a.length)[0] ?? [];
  const columns = comparison.length > 0 ? Object.keys(comparison[0]![1]) : [];
  const others = entries.filter(([key, item]) => !isScalar(item) && !comparison.some(([groupKey]) => groupKey === key));

  return (
    <div className="space-y-4">
      {scalars.length > 0 && <Metrics entries={scalars} />}
      {comparison.length > 0 && (
        <Table columns={['', ...columns]} rows={comparison.map(([key, group]) => [key, ...columns.map((column) => group[column])])} />
      )}
      {others.map(([key, item]) => <ResultValue key={key} value={item} caption={key} />)}
    </div>
  );
};

export const ComputationResultView: FC<{ data: ComputationArtifactData }> = ({ data }) => (
  <div className="space-y-3 text-sm">
    <ResultValue value={data.result} />
    {data.truncated && <p className="text-xs text-muted-foreground">结果较长，已截取前 200 行。</p>}
    {/* 计算代码保存在依据里供复核，按产品约定不向业务人员展示代码。 */}
    <p className="text-xs text-muted-foreground">数据：{data.inputs.map((input) => input.description).join('；')}</p>
  </div>
);
