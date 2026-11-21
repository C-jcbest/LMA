import type { FC, ReactNode } from 'react';
import { BellIcon, LogOutIcon, Monitor, Moon, ServerIcon, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme, type ThemePreference } from '@/app/providers/ThemeProvider';
import {
  setSystemNoticeEnabled,
  systemNoticeSupported,
  useSystemNoticeEnabled,
} from '@/features/notifications/run-completion';

const themeChoices = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;

export interface SettingsMenuActions {
  onOpenSettings?: () => void;
  onLogout?: () => void;
}

export const SettingsMenu: FC<SettingsMenuActions & { side: 'top' | 'right'; children: ReactNode }> = ({
  side,
  children,
  onOpenSettings,
  onLogout,
}) => {
  const { preference, setPreference } = useTheme();
  const noticeEnabled = useSystemNoticeEnabled();
  const currentTheme = themeChoices.find((choice) => choice.value === preference) ?? themeChoices[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={side === 'top' ? 'start' : 'end'} className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <currentTheme.icon />
            外观
            <span className="ms-auto text-xs text-muted-foreground">{currentTheme.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={preference} onValueChange={(next) => setPreference(next as ThemePreference)}>
              {themeChoices.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {systemNoticeSupported() && (
          <DropdownMenuCheckboxItem
            checked={noticeEnabled}
            onCheckedChange={(checked) => void setSystemNoticeEnabled(checked)}
          >
            <BellIcon />
            完成通知
          </DropdownMenuCheckboxItem>
        )}
        {onOpenSettings && (
          <DropdownMenuItem onSelect={onOpenSettings}>
            <ServerIcon />
            服务配置
          </DropdownMenuItem>
        )}
        {onLogout && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOutIcon />
              退出登录
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
