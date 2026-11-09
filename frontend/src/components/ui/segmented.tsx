import type { FC } from 'react';
import { ToggleGroup } from 'radix-ui';

const SEGMENT_ITEM_CLASS = 'min-h-8 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground';

interface SegmentedProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onValueChange: (value: string) => void;
}

/** 少量互斥选项；始终保持有一项被选中。 */
export const Segmented: FC<SegmentedProps> = ({ label, value, options, onValueChange }) => (
  <ToggleGroup.Root
    type="single"
    aria-label={label}
    value={value}
    onValueChange={(next) => {
      if (next) onValueChange(next);
    }}
    className="flex flex-wrap gap-1"
  >
    {options.map((option) => (
      <ToggleGroup.Item key={option.value} value={option.value} className={SEGMENT_ITEM_CLASS}>
        {option.label}
      </ToggleGroup.Item>
    ))}
  </ToggleGroup.Root>
);
