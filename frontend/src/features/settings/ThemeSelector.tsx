import { Monitor, Moon, Sun } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTheme, type ThemePreference } from '@/app/providers/ThemeProvider';

const choices = [
  { value: 'light', label: '浅色主题', icon: Sun },
  { value: 'dark', label: '深色主题', icon: Moon },
  { value: 'system', label: '跟随系统主题', icon: Monitor },
] as const;

export function ThemeSelector() {
  const { preference, setPreference } = useTheme();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0.5}
      value={preference}
      aria-label="外观主题"
      onValueChange={(next) => {
        if (next) {
          setPreference(next as ThemePreference);
        }
      }}
      className="shrink-0 rounded-lg border p-0.5"
    >
      {choices.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className="size-7 min-w-7 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground"
        >
          <Icon aria-hidden />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
