import { Monitor, Moon, Sun } from 'lucide-react';
import { ToggleGroup } from 'radix-ui';
import { useTheme, type ThemePreference } from '@/app/providers/ThemeProvider';

const choices = [
  { value: 'light', label: '浅色主题', icon: Sun },
  { value: 'dark', label: '深色主题', icon: Moon },
  { value: 'system', label: '跟随系统主题', icon: Monitor },
] as const;

export function ThemeSelector() {
  const { preference, setPreference } = useTheme();
  return (
    <ToggleGroup.Root
      type="single"
      value={preference}
      aria-label="外观主题"
      onValueChange={(next) => {
        if (next) {
          setPreference(next as ThemePreference);
        }
      }}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
    >
      {choices.map(({ value, label, icon: Icon }) => (
        <ToggleGroup.Item
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground"
        >
          <Icon className="size-4" aria-hidden />
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
