import type { FC } from 'react';
import type { ComputationArtifactData } from '@/types/envelope';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Scalar = string | number | boolean | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isFlatRecord = (value: unknown): value is Record<string, Scalar> =>
  isRecord(value) && value.type === undefined && Object.values(value).every(isScalar);

const UNIT_SUFFIX = /^(.+?)_((?:mm|cm|m|km|%|天|小时|h|d)(?:每天|每小时|每日|\/天|\/小时|\/d|\/h)?)$/;

export const formatLabel = (key: string) => {
  if (key.trim().toLowerCase() === 'index') {
    return '对象';
  }
  const match = UNIT_SUFFIX.exec(key);
  if (match) {
    const unit = match[2]!.replace(/^(.+?)每(天|日|小时)$/, '$1/$2').replace('/日', '/天');
    return `${match[1]!.replace(/_+/g, ' ')}（${unit}）`;
  }
  return key.replace(/_+/g, ' ');
};

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

const ResultTable: FC<{ columns: string[]; rows: unknown[][]; total?: number; caption?: string }> = ({ columns, rows, total, caption }) => (
  <div className="space-y-1.5">
    {caption && <p className="text-xs text-muted-foreground">{formatLabel(caption)}</p>}
    <div className="max-h-80 overflow-auto rounded-md border">
      <Table containerClassName="overflow-visible">
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>{columns.map((column, index) => <TableHead key={index} scope="col">{formatLabel(column)}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, cellIndex) => (
                <TableCell key={cellIndex} className={cellIndex === 0 ? 'whitespace-nowrap text-muted-foreground' : undefined}>
                  {cellIndex === 0 && typeof cell === 'string' ? formatLabel(cell) : formatCell(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
        <dt className="text-xs text-muted-foreground wrap-break-word">{formatLabel(key)}</dt>
        <dd className="text-base font-medium tabular-nums wrap-break-word">{formatCell(value)}</dd>
      </div>
    ))}
  </dl>
);

const ResultValue: FC<{ value: unknown; caption?: string }> = ({ value, caption }) => {
  if (isRecord(value) && value.type === 'table' && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return <ResultTable caption={caption} columns={value.columns.map(String)} rows={value.rows as unknown[][]} total={Number(value.row_count)} />;
  }
  if (isRecord(value) && value.type === 'series' && Array.isArray(value.index) && Array.isArray(value.values)) {
    const values = value.values;
    return (
      <ResultTable
        caption={caption}
        columns={['', value.name ? String(value.name) : '值']}
        rows={value.index.map((key, index) => [key, values[index]])}
        total={Number(value.row_count)}
      />
    );
  }
  if (isFlatRecord(value)) {
    return <ResultTable caption={caption} columns={['项目', '值']} rows={Object.entries(value)} />;
  }
  if (Array.isArray(value)) {
    return <ResultTable caption={caption} columns={['值']} rows={value.map((item) => [item])} />;
  }
  if (isRecord(value)) {
    return <DictionaryResult value={value} />;
  }
  return (
    <div>
      {caption && <p className="text-xs text-muted-foreground">{formatLabel(caption)}</p>}
      <p className="text-base font-medium tabular-nums">{formatCell(value)}</p>
    </div>
  );
};

const DictionaryResult: FC<{ value: Record<string, unknown> }> = ({ value }) => {
  const entries = Object.entries(value);
  const scalars = entries.filter((entry): entry is [string, Scalar] => isScalar(entry[1]));
  const flatGroups = entries.filter((entry): entry is [string, Record<string, Scalar>] => isFlatRecord(entry[1]));
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
        <ResultTable columns={['', ...columns]} rows={comparison.map(([key, group]) => [key, ...columns.map((column) => group[column])])} />
      )}
      {others.map(([key, item]) => <ResultValue key={key} value={item} caption={key} />)}
    </div>
  );
};

export const ComputationResultView: FC<{ data: ComputationArtifactData }> = ({ data }) => (
  <div className="space-y-3 text-sm">
    <ResultValue value={data.result} />
    {data.truncated && <p className="text-xs text-muted-foreground">结果较长，已截取前 200 行。</p>}
    {data.inputs.length > 0 && (
      <p className="text-xs text-muted-foreground">数据：{data.inputs.map((input) => input.description).join('；')}</p>
    )}
  </div>
);
