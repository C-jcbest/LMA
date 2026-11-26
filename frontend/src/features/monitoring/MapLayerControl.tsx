import { useEffect, type FC } from 'react';
import { LocateFixedIcon, MinusIcon, PlusIcon, RouteIcon, XIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from 'cn';
import { EASE_IN, SPRING_SNAPPY } from '@/components/ui/motion-primitives';
import type { BaseLayer, MapLayerSelection } from './basemap';

const GLASS_SURFACE = 'border border-border/70 bg-popover/88 text-popover-foreground shadow-sm backdrop-blur-md';

export function MapLayerControl({ selection, onChange, className }: {
  selection: MapLayerSelection;
  onChange: (selection: MapLayerSelection) => void;
  className?: string;
}) {
  const isSatellite = selection.baseLayer === 'satellite';
  const selectBase = (baseLayer: BaseLayer) => onChange({ ...selection, baseLayer });

  return (
    <div
      data-map-overlay=""
      className={cn('pointer-events-auto flex items-center gap-1.5', className)}
    >
      <div
        role="radiogroup"
        aria-label="底图"
        className={cn('inline-flex items-center rounded-full p-0.5 text-xs', GLASS_SURFACE)}
      >
        {([
          { value: 'satellite', label: '卫星' },
          { value: 'road', label: '地图' },
        ] as const).map((option) => {
          const active = selection.baseLayer === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => selectBase(option.value)}
              className={cn(
                'relative h-7 rounded-full px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {isSatellite && (
          <motion.button
            key="roads-toggle"
            type="button"
            aria-pressed={selection.showRoads}
            title={selection.showRoads ? '隐藏路网地名' : '叠加路网地名'}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1, transition: SPRING_SNAPPY }}
            exit={{ opacity: 0, scale: 0.92, transition: EASE_IN }}
            onClick={() => onChange({ ...selection, showRoads: !selection.showRoads })}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              GLASS_SURFACE,
              selection.showRoads ? 'border-foreground/30 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <RouteIcon className="size-3.5" aria-hidden />
            路网
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

export const MapZoomControls: FC<{
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  className?: string;
}> = ({ onZoomIn, onZoomOut, onFitView, className }) => (
  <div
    data-map-overlay=""
    role="group"
    aria-label="地图缩放"
    className={cn('pointer-events-auto flex flex-col overflow-hidden rounded-xl', GLASS_SURFACE, className)}
  >
    <button
      type="button"
      onClick={onZoomIn}
      aria-label="放大地图"
      title="放大"
      className="flex size-8 items-center justify-center text-muted-foreground transition hover:bg-muted/70 hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PlusIcon className="size-4" aria-hidden />
    </button>
    <span aria-hidden className="h-px bg-border/70" />
    <button
      type="button"
      onClick={onZoomOut}
      aria-label="缩小地图"
      title="缩小"
      className="flex size-8 items-center justify-center text-muted-foreground transition hover:bg-muted/70 hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MinusIcon className="size-4" aria-hidden />
    </button>
    <span aria-hidden className="h-px bg-border/70" />
    <button
      type="button"
      onClick={onFitView}
      aria-label="复位全览"
      title="复位全览"
      className="flex size-8 items-center justify-center text-muted-foreground transition hover:bg-muted/70 hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LocateFixedIcon className="size-3.5" aria-hidden />
    </button>
  </div>
);

export interface MapSheetInfo {
  id: string;
  name: string;
  context: string;
  stationType?: string | null;
  colorToken: string;
  status?: string | null;
  reason?: string | null;
  metric?: { label: string; value: string; unit: string; direction: string | null };
  fields: Array<{ label: string; value: string; wide?: boolean }>;
  note?: string;
  action?: { label: string; run: () => void };
}

export interface ClusterOption {
  id: string;
  name: string;
  colorToken: string;
}

export const MapStationSheet: FC<{
  info: MapSheetInfo | null;
  clusterOptions?: readonly ClusterOption[];
  activeClusterId?: string;
  onSelectClusterMember?: (id: string) => void;
  docked?: boolean;
  onClose: () => void;
}> = ({ info, clusterOptions, activeClusterId, onSelectClusterMember, docked = false, onClose }) => {
  useEffect(() => {
    if (!info) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [info, onClose]);

  const showSwitcher = Boolean(clusterOptions && clusterOptions.length > 1 && onSelectClusterMember);

  return (
    <AnimatePresence initial={false}>
      {info && (
        <motion.section
          key={docked ? 'docked-sheet' : info.id}
          data-map-overlay=""
          aria-label={`${info.name} 测点信息`}
          initial={docked ? { opacity: 0, height: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
          animate={docked ? { opacity: 1, height: 'auto', transition: SPRING_SNAPPY } : { opacity: 1, y: 0, scale: 1, transition: SPRING_SNAPPY }}
          exit={docked ? { opacity: 0, height: 0, transition: EASE_IN } : { opacity: 0, y: 8, scale: 0.98, transition: EASE_IN }}
          className={cn(
            'pointer-events-auto flex flex-col overflow-hidden text-start text-sm text-popover-foreground',
            docked
              ? 'border-t border-border/70 bg-card px-3.5 py-3'
              : 'absolute bottom-3 start-3 z-30 max-h-[calc(100%-3.5rem)] w-76 rounded-xl border border-border/80 bg-popover/95 p-3.5 shadow-lg backdrop-blur-md',
          )}
        >
          {showSwitcher && (
            <div className="mb-2.5 flex items-center gap-1 overflow-x-auto pb-0.5">
              {clusterOptions!.map((member) => {
                const active = member.id === activeClusterId;
                return (
                  <button
                    key={member.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelectClusterMember!(member.id)}
                    className={cn(
                      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-foreground/30 bg-foreground font-medium text-background'
                        : 'border-border/70 bg-muted/60 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: `var(${member.colorToken})` }}
                    />
                    <span>{member.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          <header className="flex shrink-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: `var(${info.colorToken})` }}
                />
                <span className="truncate">{info.context}</span>
                {info.stationType && !info.stationType.startsWith('移动站') && (
                  <span className="shrink-0">· {info.stationType}</span>
                )}
                {info.status && <span className="shrink-0 font-medium text-foreground">· {info.status}</span>}
              </div>
              <h3 className="mt-0.5 truncate text-base font-semibold leading-snug">{info.name}</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭测点信息"
              className="-me-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-4" aria-hidden />
            </button>
          </header>

          <div className={cn('mt-2 space-y-2', !docked && 'min-h-0 flex-1 overflow-y-auto overscroll-contain pe-0.5')}>
            {info.reason && (
              <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground wrap-anywhere">{info.reason}</p>
            )}
            {info.metric && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-lg bg-muted/70 px-3 py-2">
                <div>
                  <p className="text-xs text-muted-foreground">{info.metric.label}</p>
                  <div className="mt-0.5 flex items-baseline gap-1 tabular-nums">
                    <span className="text-xl font-semibold tracking-tight">{info.metric.value}</span>
                    <span className="text-xs text-muted-foreground">{info.metric.unit}</span>
                  </div>
                </div>
                {info.metric.direction && (
                  <p className="text-xs text-muted-foreground">{info.metric.direction}</p>
                )}
              </div>
            )}
            {info.fields.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {info.fields.map((field) => (
                  <div key={field.label} className={cn('min-w-0', field.wide && 'col-span-2')}>
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="mt-0.5 font-medium tabular-nums wrap-anywhere">{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {info.note && <p className="text-xs text-muted-foreground">{info.note}</p>}
          </div>

          {info.action && (
            <button
              type="button"
              onClick={info.action.run}
              className="mt-3 flex h-9 w-full shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-medium text-primary-foreground transition hover:opacity-92 active:scale-99 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {info.action.label}
            </button>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
};
