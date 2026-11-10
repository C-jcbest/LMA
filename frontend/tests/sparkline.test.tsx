import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from '../src/features/monitoring/InvestigationProcess';

describe('测点趋势缩略图', () => {
  it('缺测前后为独立线段，不跨缺测连线', () => {
    const { container } = render(<Sparkline values={[0, 1, null, 2, 3]} />);
    const path = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it('有效数据不足两个点时不绘制趋势', () => {
    const { container } = render(<Sparkline values={[null, 1, null]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
