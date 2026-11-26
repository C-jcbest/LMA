import { useEffect, useState } from 'react';
import AMapLoader from '@amap/amap-jsapi-loader';
import '@amap/amap-jsapi-types';
import gcoord from 'gcoord';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import type { LmaClient } from '@/services/api';
import type { Coordinates } from './coordinates';

export type BaseLayer = 'satellite' | 'road';
export interface MapLayerSelection {
  baseLayer: BaseLayer;
  showRoads: boolean;
}

export const DEFAULT_LAYER_SELECTION: MapLayerSelection = { baseLayer: 'satellite', showRoads: false };

export const MAP_2D_OPTIONS = { viewMode: '2D' as const, pitch: 0, pitchEnable: false };
export type AMapState = { status: 'loading' } | { status: 'ready'; sdk: typeof AMap } | { status: 'error'; message: string };

export const amapPosition = (location: Coordinates): [number, number] =>
  gcoord.transform([location.longitude, location.latitude], gcoord.WGS84, gcoord.GCJ02) as [number, number];

const sdkRequests = new WeakMap<LmaClient, Promise<typeof AMap>>();

function requestSdk(client: LmaClient): Promise<typeof AMap> {
  let request = sdkRequests.get(client);
  if (!request) {
    request = client.getMapConfig()
      .catch(() => {
        throw new Error('地图配置读取失败，请检查服务连接后刷新。');
      })
      .then((config) => {
        if (!config.amap_token) {
          throw new Error('未配置高德地图密钥，暂时无法加载地图。');
        }
        return AMapLoader.load({
          key: config.amap_token,
          version: '2.0',
          plugins: ['AMap.Scale'],
        }).catch(() => {
          throw new Error('高德地图加载失败，请检查地图密钥和网络后刷新。');
        });
      })
      .catch((error: Error) => {
        sdkRequests.delete(client);
        throw error;
      });
    sdkRequests.set(client, request);
  }
  return request;
}

export function useAMap(): AMapState {
  const client = useLmaClient();
  const [state, setState] = useState<AMapState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    void requestSdk(client).then((sdk) => {
      if (active) {
        setState({ status: 'ready', sdk });
      }
    }).catch((error: Error) => {
      if (active) {
        setState({ status: 'error', message: error.message });
      }
    });
    return () => {
      active = false;
    };
  }, [client]);
  return state;
}

export function createBaseLayers(sdk: typeof AMap, selection: MapLayerSelection) {
  const road = typeof sdk.createDefaultLayer === 'function' ? sdk.createDefaultLayer() : new sdk.TileLayer();
  const satellite = new sdk.TileLayer.Satellite();
  const roadLabels = new sdk.TileLayer.RoadNet();
  const select = ({ baseLayer, showRoads }: MapLayerSelection) => {
    if (baseLayer === 'road') {
      road.show();
      roadLabels.hide();
      satellite.hide();
    } else {
      satellite.show();
      if (showRoads) {
        roadLabels.show();
      } else {
        roadLabels.hide();
      }
      road.hide();
    }
  };
  select(selection);
  return { layers: [road, satellite, roadLabels], select };
}

export function applyMapStyle(map: AMap.Map, baseLayer: BaseLayer, resolvedTheme: 'light' | 'dark') {
  map.setMapStyle?.(baseLayer === 'road' && resolvedTheme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal');
}

export function bindMapWheelZoom(map: AMap.Map, container: HTMLElement) {
  const onWheel = (event: WheelEvent) => {
    const insidePopup = event.target instanceof Element && event.target.closest('[data-map-overlay]');
    if (insidePopup || event.ctrlKey || event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      delta *= 40;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      delta *= container.clientHeight;
    }
    const [minimum, maximum] = map.getZooms();
    const change = Math.max(-1, Math.min(1, -delta / 240));
    const immediate = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    map.setZoom(Math.max(minimum, Math.min(maximum, map.getZoom() + change)), immediate);
  };
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => container.removeEventListener('wheel', onWheel, true);
}
