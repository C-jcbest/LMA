import { expect, it } from 'vitest';
import { validCoordinates } from '../src/features/monitoring/coordinates';
import { amapPosition, bindMapWheelZoom, createBaseLayers } from '../src/features/monitoring/basemap';

it('卫星图默认只有影像，道路与地名需主动开启，普通地图不重复叠加路网', () => {
  class Layer {
    visible = true;
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
  }
  const sdk = { TileLayer: Object.assign(Layer, { Satellite: Layer, RoadNet: Layer }) } as unknown as typeof AMap;
  const base = createBaseLayers(sdk, { baseLayer: 'satellite', showRoads: false });
  const visibility = () => base.layers.map((layer) => (layer as unknown as Layer).visible);
  expect(visibility()).toEqual([false, true, false]);
  base.select({ baseLayer: 'satellite', showRoads: true });
  expect(visibility()).toEqual([false, true, true]);
  base.select({ baseLayer: 'road', showRoads: true });
  expect(visibility()).toEqual([true, false, false]);
  base.select({ baseLayer: 'satellite', showRoads: false });
  expect(visibility()).toEqual([false, true, false]);
});

it('拒绝线上出现的经纬度填反、越界和缺失值，不猜测交换坐标', () => {
  expect(validCoordinates({ latitude: 116.467877157, longitude: 40.005701073 })).toBe(false);
  expect(validCoordinates({ latitude: 39.87, longitude: 181 })).toBe(false);
  expect(validCoordinates({ latitude: NaN, longitude: 116 })).toBe(false);
  expect(validCoordinates({ latitude: null, longitude: 116 })).toBe(false);
  expect(validCoordinates(undefined)).toBe(false);
  expect(validCoordinates({ latitude: 31.547764577, longitude: 103.285741073 })).toBe(true);
  expect(validCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
});

it('高德展示将 WGS84 转为 GCJ-02，保留原始观测坐标', () => {
  const original = { latitude: 39.915, longitude: 116.404 };
  const position = amapPosition(original);
  expect(position[0]).toBeCloseTo(116.4102445, 5);
  expect(position[1]).toBeCloseTo(39.9164043, 5);
  expect(original).toEqual({ latitude: 39.915, longitude: 116.404 });
});

it('地图滚轮可放大缩小并限制级别，移除监听后恢复页面滚动', () => {
  const container = document.createElement('div');
  let zoom = 16;
  const map = {
    getZoom: () => zoom,
    getZooms: () => [2, 20],
    setZoom: (value: number) => { zoom = value; },
  } as unknown as AMap.Map;
  const unbind = bindMapWheelZoom(map, container);
  const wheel = (deltaY: number, deltaMode = 0) => {
    const event = new WheelEvent('wheel', { deltaY, deltaMode, cancelable: true });
    container.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(wheel(-240)).toBe(true);
  expect(zoom).toBe(17);
  wheel(6, WheelEvent.DOM_DELTA_LINE);
  expect(zoom).toBe(16);
  const popup = document.createElement('div');
  popup.className = 'map-station-popup';
  container.append(popup);
  const popupWheel = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
  popup.dispatchEvent(popupWheel);
  expect(popupWheel.defaultPrevented).toBe(false);
  expect(zoom).toBe(16);
  zoom = 20;
  wheel(-240);
  expect(zoom).toBe(20);
  zoom = 2;
  wheel(240);
  expect(zoom).toBe(2);
  unbind();
  expect(wheel(-240)).toBe(false);
  expect(zoom).toBe(2);
});
