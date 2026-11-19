import type { FC } from 'react';
import { BellIcon, BellOffIcon } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { setSystemNoticeEnabled, systemNoticeSupported, useSystemNoticeEnabled } from './run-completion';

/** 导航底部的“完成通知”：开启后，调查在后台或别的会话里完成时弹出系统通知。浏览器不支持时不显示。 */
export const SystemNoticeToggle: FC = () => {
  const enabled = useSystemNoticeEnabled();
  if (!systemNoticeSupported()) {
    return null;
  }
  return (
    <div className="flex h-9 items-center justify-between gap-2 ps-2.5">
      <span className="text-sm text-muted-foreground">完成通知</span>
      <Toggle
        size="sm"
        pressed={enabled}
        onPressedChange={(pressed) => void setSystemNoticeEnabled(pressed)}
        aria-label={enabled ? '关闭调查完成通知' : '开启调查完成通知'}
        title={enabled ? '已开启' : '开启后需要浏览器授权'}
      >
        {enabled ? <BellIcon /> : <BellOffIcon />}
      </Toggle>
    </div>
  );
};
