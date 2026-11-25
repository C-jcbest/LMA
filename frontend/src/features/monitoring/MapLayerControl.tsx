import { cn } from 'cn';
import { Segmented } from '@/components/ui/segmented';
import type { BaseLayer, MapLayerSelection } from './basemap';

export function MapLayerControl({ selection, onChange }: {
  selection: MapLayerSelection;
  onChange: (selection: MapLayerSelection) => void;
}) {
  const isRoad = selection.baseLayer === 'road';
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
      <Segmented label='底图' value={selection.baseLayer}
        options={[{ value: 'satellite', label: '卫星图' }, { value: 'road', label: '普通地图' }]}
        onValueChange={(value) => onChange({ ...selection, baseLayer: value as BaseLayer })} />
      <div className='flex flex-wrap items-center gap-x-4'>
        <label
          title={isRoad ? '普通地图已包含道路与地名' : undefined}
          className={cn(
            'flex min-h-9 items-center gap-2 text-sm text-muted-foreground select-none',
            isRoad ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:text-foreground',
          )}
        >
          <input type='checkbox'
            checked={isRoad ? true : selection.showRoads}
            disabled={isRoad}
            onChange={(event) => onChange({ ...selection, showRoads: event.target.checked })}
            className='size-4 rounded-sm border-input accent-primary' />
          道路与地名
        </label>
        <label className='flex min-h-9 cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none hover:text-foreground'>
          <input type='checkbox' checked={selection.terrain3d}
            onChange={(event) => onChange({ ...selection, terrain3d: event.target.checked })}
            className='size-4 rounded-sm border-input accent-primary' />
          3D 地形
        </label>
      </div>
    </div>
  );
}
