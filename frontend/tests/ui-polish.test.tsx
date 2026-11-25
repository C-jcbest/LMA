import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LmaClientContext } from '@/app/providers/LmaClientContext';
import { NavigationProvider } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { SessionUndoProvider, useSessionUndo } from '@/components/ui/motion-primitives';
import { InspectionProvider } from '@/features/inspection/InspectionContext';
import { StationsPage } from '@/features/stations/StationsPage';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import type { LmaClient, Station } from '@/services/api';

function UndoProbe({ onCommit }: { onCommit: () => Promise<void> }) {
  const { pendingIds, scheduleDelete } = useSessionUndo();
  return (
    <div>
      <button type="button" onClick={() => scheduleDelete('item-1', '测试会话', onCommit)}>
        删除会话
      </button>
      <span data-testid="pending-count">{pendingIds.size}</span>
    </div>
  );
}

describe('UI 体验与动效约束回归测试', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('主按钮禁用态使用对比清晰的语义底色而非整块褪色', () => {
    render(<Button disabled>提交</Button>);
    const btn = screen.getByRole('button', { name: '提交' });
    expect(btn.className).toContain('disabled:bg-muted');
    expect(btn.className).toContain('disabled:text-muted-foreground');
    expect(btn.className).toContain('disabled:opacity-100');
  });

  it('会话删除支持 5 秒内撤销且撤销后不触发后端删除', async () => {
    vi.useFakeTimers();
    const commit = vi.fn().mockResolvedValue(undefined);
    render(
      <MotionConfig reducedMotion="user">
        <SessionUndoProvider>
          <UndoProbe onCommit={commit} />
        </SessionUndoProvider>
      </MotionConfig>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    expect(screen.getByTestId('pending-count')).toHaveTextContent('1');
    expect(commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByTestId('pending-count')).toHaveTextContent('0');

    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('测点页面仅有一组时自动展示分组概览地图区域', async () => {
    const stations: Station[] = [
      {
        station_uuid: 'st-1',
        station_name: 'K1-01',
        group_name: '唯一分组',
        station_type: '移动站RTK模式',
        station_status: '正常',
        latitude: 30.1,
        longitude: 103.2,
      },
    ];
    const client = {
      listStations: vi.fn().mockResolvedValue(stations),
      listSessions: vi.fn().mockResolvedValue([]),
      getLatestInspection: vi.fn().mockResolvedValue({ inspection: null, latest_attempt: null, running: null, stations: [] }),
      getMapConfig: vi.fn().mockResolvedValue({ amap_token: null }),
    } as unknown as LmaClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <LmaClientContext.Provider value={client}>
          <AssistantProvider client={client}>
            <NavigationProvider>
              <InspectionProvider>
                <StationsPage />
              </InspectionProvider>
            </NavigationProvider>
          </AssistantProvider>
        </LmaClientContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('K1-01')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '唯一分组位置概览' })).toBeInTheDocument();
  });

  it('测点页面非激活态时卸载分组地图，避免隐藏容器触发 3D 渲染异常', async () => {
    const stations: Station[] = [
      {
        station_uuid: 'st-1',
        station_name: 'K1-01',
        group_name: '唯一分组',
        station_type: '移动站RTK模式',
        station_status: '正常',
        latitude: 30.1,
        longitude: 103.2,
      },
    ];
    const client = {
      listStations: vi.fn().mockResolvedValue(stations),
      listSessions: vi.fn().mockResolvedValue([]),
      getLatestInspection: vi.fn().mockResolvedValue({ inspection: null, latest_attempt: null, running: null, stations: [] }),
      getMapConfig: vi.fn().mockResolvedValue({ amap_token: null }),
    } as unknown as LmaClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <LmaClientContext.Provider value={client}>
          <AssistantProvider client={client}>
            <NavigationProvider>
              <InspectionProvider>
                <StationsPage active={false} />
              </InspectionProvider>
            </NavigationProvider>
          </AssistantProvider>
        </LmaClientContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('K1-01')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '唯一分组位置概览' })).not.toBeInTheDocument();
  });
});
