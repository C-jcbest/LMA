import { useEffect, useState } from 'react';
import AMapLoader from '@amap/amap-jsapi-loader';
import '@amap/amap-jsapi-types';
import gcoord from 'gcoord';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import type { LmaClient } from '@/services/api';
import type { Coordinates } from './coordinates';

export type BaseLayer = 'satellite' | 'road';
export type AMapState = { status: 'loading' } | { status: 'ready'; sdk: typeof AMap } | { status: 'error'; message: string };

/** 只在展示边界转换，观测数据、环境查询和坐标文字仍使用 WGS84。 */
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
          plugins: ['AMap.Scale', 'AMap.ToolBar', 'AMap.CustomLayer'],
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

/** 路网为普通地图，影像附带中文标注；两张地图共享相同的底图切换。 */
export function createBaseLayers(sdk: typeof AMap, base: BaseLayer) {
  const road = new sdk.TileLayer();
  const satellite = new sdk.TileLayer.Satellite();
  const labels = new sdk.TileLayer.RoadNet();
  const select = (value: BaseLayer) => {
    if (value === 'road') {
      road.show();
      satellite.hide();
      labels.hide();
    } else {
      road.hide();
      satellite.show();
      labels.show();
    }
  };
  select(base);
  return { layers: [road, satellite, labels], select };
}

/** 当前高德 2.0 手势处理会吞掉滚轮而不缩放；两张地图统一用公开 API 控制。 */
export function bindMapWheelZoom(map: AMap.Map, container: HTMLElement) {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.deltaY === 0) {
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
    map.setZoom(Math.max(minimum, Math.min(maximum, map.getZoom() + change)), true);
  };
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => container.removeEventListener('wheel', onWheel, true);
}
