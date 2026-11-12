import { expect, it } from 'vitest';
import { validCoordinates } from '../src/features/monitoring/coordinates';
import { amapPosition, bindMapWheelZoom } from '../src/features/monitoring/basemap';

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
