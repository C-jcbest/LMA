import type { FC } from 'react';
import { cn } from 'cn';
import { formatSigned, MILLIMETER_DIGITS } from '@/features/monitoring/format';
import type { ScreeningFinding } from '@/services/api';

const AXIS_NAMES: Record<string, string> = { n: '北向', e: '东向', u: '垂直' };

/** 一条初筛线索的短标签：方向 + 现象，近期小时序列加“近期”前缀；完整句子放在悬停提示里。 */
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
    case 'gap':
      return '缺测';
    default:
      return '数据问题';
  }
}

/** 线索自身的幅度与窗口，例如“+8.2 mm / 90 天”；没有幅度时为 null。 */
export function findingAmount(finding: ScreeningFinding): string | null {
  if (finding.value_mm === null) {
    return null;
  }
  const amount = `${formatSigned(finding.value_mm, MILLIMETER_DIGITS)} mm`;
  return finding.days ? `${amount} / ${Math.round(finding.days)} 天` : amount;
}

export const triggersOf = (findings: readonly ScreeningFinding[]) => findings.filter((finding) => finding.role === 'trigger');

/** 数据质量线索按标签去重，同一类问题只显示一次。 */
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

/**
 * 测点的初筛线索：调查理由在前、数据质量在后，标签之外不再重复整句；
 * limit 控制显示几条调查理由，其余合并为“另 N 条”。
 */
export const FindingChips: FC<{ findings: readonly ScreeningFinding[]; limit?: number; className?: string }> = ({ findings, limit = Infinity, className }) => {
  const triggers = triggersOf(findings);
  const visible = triggers.slice(0, limit);
  const hidden = triggers.slice(limit);
  const quality = qualityLabelsOf(findings);
  if (triggers.length === 0 && quality.length === 0) {
    return null;
  }
  return (
    <ul aria-label="初筛线索" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {visible.map((finding, index) => {
        const amount = findingAmount(finding);
        return (
          <li key={index} title={finding.text}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-full bg-status-attention/12 px-2.5 text-xs font-medium text-foreground">
            {findingLabel(finding)}
            {amount && <span className="font-normal tabular-nums text-muted-foreground">{amount}</span>}
          </li>
        );
      })}
      {hidden.length > 0 && (
        <li title={hidden.map((finding) => finding.text).join('\n')} className="px-1 text-xs text-muted-foreground">
          另 {hidden.length} 条
        </li>
      )}
      {quality.map((item) => (
        <li key={item.label} title={item.detail}
          className="inline-flex min-h-6 items-center rounded-full border px-2.5 text-xs text-muted-foreground">
          {item.label}
        </li>
      ))}
    </ul>
  );
};
