import { Segmented } from '@/components/ui/segmented';
import type { BaseLayer, MapLayerSelection } from './basemap';

export function MapLayerControl({ selection, onChange }: {
  selection: MapLayerSelection;
  onChange: (selection: MapLayerSelection) => void;
}) {
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
      <Segmented label='底图' value={selection.baseLayer}
        options={[{ value: 'satellite', label: '卫星图' }, { value: 'road', label: '普通地图' }]}
        onValueChange={(value) => onChange({ ...selection, baseLayer: value as BaseLayer })} />
      <div className='flex flex-wrap items-center gap-x-4'>
        {selection.baseLayer === 'satellite' ? (
          <label className='flex min-h-10 cursor-pointer items-center gap-2 text-sm text-muted-foreground'>
            <input type='checkbox' checked={selection.showRoads}
              onChange={(event) => onChange({ ...selection, showRoads: event.target.checked })}
              className='size-4 accent-primary' />
            道路与地名
          </label>
        ) : (
          <span className='text-xs text-muted-foreground'>普通地图包含道路与地名</span>
        )}
        <label className='flex min-h-10 cursor-pointer items-center gap-2 text-sm text-muted-foreground'>
          <input type='checkbox' checked={selection.terrain3d}
            onChange={(event) => onChange({ ...selection, terrain3d: event.target.checked })}
            className='size-4 accent-primary' />
          3D 地形
        </label>
      </div>
    </div>
  );
}
