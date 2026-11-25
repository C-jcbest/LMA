import { useId, type FC } from 'react';
import { motion } from 'motion/react';
import { SPRING_SNAPPY } from '@/components/ui/motion-primitives';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface SegmentedOption {
  value: string;
  label: string;
  count?: number;
}

interface SegmentedProps {
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  onValueChange: (value: string) => void;
}

export const Segmented: FC<SegmentedProps> = ({ label, value, options, onValueChange }) => {
  const indicatorId = useId();
  return (
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
      {options.map((option) => {
        const active = option.value === value;
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            className="relative px-2.5 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground"
          >
            {active && (
              <motion.span
                layoutId={indicatorId}
                transition={SPRING_SNAPPY}
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-md bg-muted"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              <span>{option.label}</span>
              {option.count !== undefined && (
                <span className="text-xs text-muted-foreground/80 tabular-nums">{option.count}</span>
              )}
            </span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
};
