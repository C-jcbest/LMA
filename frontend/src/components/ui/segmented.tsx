import type { FC } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface SegmentedProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onValueChange: (value: string) => void;
}

/** 少量互斥选项；始终保持有一项被选中。 */
export const Segmented: FC<SegmentedProps> = ({ label, value, options, onValueChange }) => (
  <ToggleGroup
    type="single"
    size="sm"
    spacing={1}
    aria-label={label}
    value={value}
    onValueChange={(next) => {
      if (next) {
        onValueChange(next);
      }
    }}
    className="flex-wrap"
  >
    {options.map((option) => (
      <ToggleGroupItem
        key={option.value}
        value={option.value}
        className="px-2.5 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground"
      >
        {option.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);
