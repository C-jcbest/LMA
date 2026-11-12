import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import gcoord from 'gcoord';

interface GeologyShape {
  paths: [number, number][][];
  bounds: [number, number, number, number];
  fill: string | null;
}

interface LayerOptions {
  geology: boolean;
  faults: boolean;
}

const TILE_URL = 'https://tiles.macrostrat.org/carto';
const tileX = (longitude: number, zoom: number) => Math.max(0, Math.min(2 ** zoom - 1, Math.floor((longitude + 180) / 360 * 2 ** zoom)));
const tileY = (latitude: number, zoom: number) => {
  const radians = Math.max(-85.0511, Math.min(85.0511, latitude)) * Math.PI / 180;
  return Math.max(0, Math.min(2 ** zoom - 1, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom)));
};

/** Macrostrat 的 WGS84 矢量瓦片转为 GCJ-02 后绘制，不能直接叠在高德底图上。 */
function decodeShapes(buffer: ArrayBuffer, x: number, y: number, zoom: number): GeologyShape[] {
  const tile = new VectorTile(new PbfReader(buffer));
  const shapes: GeologyShape[] = [];
  for (const name of ['units', 'lines']) {
    const layer = tile.layers[name];
    if (!layer) {
      continue;
    }
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i).toGeoJSON(x, y, zoom);
      const geometry = feature.geometry;
      let rings: number[][][];
      if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
        rings = geometry.coordinates;
      } else if (geometry.type === 'MultiPolygon') {
        rings = geometry.coordinates.flat();
      } else if (geometry.type === 'LineString') {
        rings = [geometry.coordinates];
      } else {
        continue;
      }
      const bounds: GeologyShape['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
      const paths = rings.map((ring) => ring.map((point) => {
        const position = gcoord.transform([point[0]!, point[1]!], gcoord.WGS84, gcoord.GCJ02) as [number, number];
        bounds[0] = Math.min(bounds[0], position[0]);
        bounds[1] = Math.min(bounds[1], position[1]);
        bounds[2] = Math.max(bounds[2], position[0]);
        bounds[3] = Math.max(bounds[3], position[1]);
        return position;
      }));
      shapes.push({ paths, bounds, fill: name === 'units' ? String(feature.properties?.color || '#d4b483') : null });
    }
  }
  return shapes;
}

/** 高德自定义 Canvas 图层：同一份区域地质资料随平移、缩放重投影，测点交互仍由高德处理。 */
export function createGeologyLayer(sdk: typeof AMap, map: AMap.Map, onErrorChange: (message: string) => void, onFaults: (available: boolean) => void) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const controller = new AbortController();
  const cache = new Map<string, Promise<GeologyShape[]>>();
  let options: LayerOptions = { geology: false, faults: true };
  let shapes: GeologyShape[] = [];
  let generation = 0;
  let destroyed = false;

  const render = () => {
    if (destroyed) {
      return;
    }
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    context.scale(ratio, ratio);
    const bounds = map.getBounds() as AMap.Bounds;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const view: [number, number][] = [[sw.lng, sw.lat], [ne.lng, sw.lat], [ne.lng, ne.lat], [sw.lng, ne.lat]];
    let hasFaults = false;
    for (const shape of shapes) {
      if (shape.fill ? !options.geology : !options.faults) {
        continue;
      }
      if (shape.bounds[2] < sw.lng || shape.bounds[0] > ne.lng || shape.bounds[3] < sw.lat || shape.bounds[1] > ne.lat) {
        continue;
      }
      context.beginPath();
      for (const path of shape.paths) {
        if (!shape.fill && !hasFaults) {
          hasFaults = path.some((point, index) => sdk.GeometryUtil.isPointInRing(point, view)
            || (index > 0 && sdk.GeometryUtil.doesSegmentRingIntersect(path[index - 1]!, point, view)));
        }
        path.forEach((point, index) => {
          const pixel = map.lngLatToContainer(point);
          if (index === 0) {
            context.moveTo(pixel.x, pixel.y);
          } else {
            context.lineTo(pixel.x, pixel.y);
          }
        });
        if (shape.fill) {
          context.closePath();
        }
      }
      if (shape.fill) {
        context.fillStyle = shape.fill;
        context.globalAlpha = 0.2;
        context.fill('evenodd');
      } else {
        context.strokeStyle = '#e11d48';
        context.lineWidth = 2.8;
        context.globalAlpha = 0.95;
        context.stroke();
      }
    }
    return hasFaults;
  };
  const layer = new sdk.CustomLayer(canvas, { zIndex: 120, render });
  layer.setMap(map);

  const loadVisibleTiles = async () => {
    if (!options.geology && !options.faults) {
      render();
      return;
    }
    const current = ++generation;
    const bounds = map.getBounds() as AMap.Bounds;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const southwest = gcoord.transform([sw.lng, sw.lat], gcoord.GCJ02, gcoord.WGS84);
    const northeast = gcoord.transform([ne.lng, ne.lat], gcoord.GCJ02, gcoord.WGS84);
    // 国内区域数据最高约 5 级；高倍缩放复用该级地质单元，不伪造场地级精度。
    const zoom = Math.max(0, Math.min(5, Math.floor(map.getZoom())));
    const requests: Promise<GeologyShape[]>[] = [];
    for (let x = tileX(southwest[0]!, zoom); x <= tileX(northeast[0]!, zoom); x += 1) {
      for (let y = tileY(northeast[1]!, zoom); y <= tileY(southwest[1]!, zoom); y += 1) {
        const key = `${zoom}/${x}/${y}`;
        let request = cache.get(key);
        if (!request) {
          request = fetch(`${TILE_URL}/${key}.mvt`, { signal: controller.signal })
            .then((response) => {
              if (!response.ok) {
                throw new Error('地质图层请求失败');
              }
              return response.arrayBuffer();
            })
            .then((buffer) => decodeShapes(buffer, x, y, zoom))
            .catch((error: unknown) => {
              cache.delete(key);
              throw error;
            });
          cache.set(key, request);
          if (cache.size > 16) {
            cache.delete(cache.keys().next().value!);
          }
        }
        requests.push(request);
      }
    }
    try {
      const tiles = await Promise.all(requests);
      if (!destroyed && current === generation) {
        shapes = tiles.flat();
        onErrorChange('');
        onFaults(render() ?? false);
      }
    } catch {
      if (!destroyed && current === generation) {
        onErrorChange('区域地质图层暂时不可用，仍可查看高德底图、测点和已获取的环境资料。');
      }
    }
  };
  map.on('moveend', loadVisibleTiles);
  map.on('zoomend', loadVisibleTiles);
  map.on('complete', loadVisibleTiles);
  void loadVisibleTiles();
  return {
    select(next: LayerOptions) {
      options = next;
      void loadVisibleTiles();
    },
    destroy() {
      destroyed = true;
      controller.abort();
      map.off('moveend', loadVisibleTiles);
      map.off('zoomend', loadVisibleTiles);
      map.off('complete', loadVisibleTiles);
      layer.setMap(null);
      cache.clear();
    },
  };
}
