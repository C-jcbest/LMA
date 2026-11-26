import { useState, type FC } from 'react';
import { cn } from 'cn';
import { formatSigned, MILLIMETER_DIGITS } from '@/features/monitoring/format';
import type { ScreeningFinding } from '@/services/api';

const AXIS_NAMES: Record<string, string> = { n: '北向', e: '东向', u: '垂直' };

export function findingLabel(finding: ScreeningFinding): string {
  const axis = finding.axis ? AXIS_NAMES[finding.axis] ?? '' : '';
  const recent = finding.window === 'recent' ? '近期' : '';
  switch (finding.kind) {
    case 'trend':
      return `${recent}${axis}持续变化`;
    case 'acceleration':
      return `${axis}近期变快`;
    case 'held_step':
      return `${recent}${axis}台阶保持`;
    case 'tail_step':
      return `${recent}${axis}末端跳变`;
    case 'gap_jump':
      return `${recent}${axis}缺测前后位移`;
    case 'spike':
      return '异常跳点';
    case 'common_spike':
      return '同组同时跳点';
    case 'gap':
      return '缺测';
    default:
      return '数据问题';
  }
}

export function findingAmount(finding: ScreeningFinding): string | null {
  if (finding.value_mm === null) {
    return null;
  }
  return `${formatSigned(finding.value_mm, MILLIMETER_DIGITS)} mm`;
}

export const triggersOf = (findings: readonly ScreeningFinding[]) => findings.filter((finding) => finding.role === 'trigger');

export function qualityLabelsOf(findings: readonly ScreeningFinding[]) {
  const byLabel = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.role !== 'quality') {
      continue;
    }
    const label = findingLabel(finding);
    byLabel.set(label, [...(byLabel.get(label) ?? []), finding.text]);
  }
  return [...byLabel].map(([label, texts]) => ({ label, detail: texts.join('\n') }));
}

export const FindingChips: FC<{
  findings: readonly ScreeningFinding[];
  limit?: number;
  qualityLimit?: number;
  showAmount?: boolean;
  className?: string;
}> = ({ findings, limit = Infinity, qualityLimit = Infinity, showAmount = true, className }) => {
  const [expanded, setExpanded] = useState(false);
  const triggers = triggersOf(findings);
  const visible = expanded ? triggers : triggers.slice(0, limit);
  const hidden = expanded ? [] : triggers.slice(limit);
  const quality = qualityLabelsOf(findings);
  const visibleQuality = expanded ? quality : quality.slice(0, qualityLimit);
  const hiddenQuality = expanded ? [] : quality.slice(qualityLimit);
  if (triggers.length === 0 && quality.length === 0) {
    return null;
  }
  const hasHidden = hidden.length > 0 || hiddenQuality.length > 0;
  return (
    <span role="list" aria-label="初筛线索" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {visible.map((finding, index) => {
        const amount = showAmount ? findingAmount(finding) : null;
        return (
          <span role="listitem" key={index} title={finding.text}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-full bg-status-attention/12 px-2.5 text-xs font-medium text-foreground">
            {findingLabel(finding)}
            {amount && <span className="font-normal tabular-nums text-muted-foreground">{amount}</span>}
          </span>
        );
      })}
      {visibleQuality.map((item) => (
        <span role="listitem" key={item.label} title={item.detail}
          className="inline-flex min-h-6 items-center rounded-full border px-2.5 text-xs text-muted-foreground">
          {item.label}
        </span>
      ))}
      {hasHidden && (
        <span
          role="button"
          tabIndex={0}
          aria-expanded={false}
          title={[...hidden.map((finding) => finding.text), ...hiddenQuality.map((item) => `${item.label}：${item.detail}`)].join('\n')}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
            }
          }}
          className="inline-flex min-h-6 items-center rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          另 {hidden.length + hiddenQuality.length} 条
        </span>
      )}
    </span>
  );
};
