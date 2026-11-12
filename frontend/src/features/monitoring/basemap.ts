import { useEffect, useState } from 'react';
import type { SourceSpecification } from 'maplibre-gl';
import { useLmaClient } from '@/app/providers/LmaClientContext';
import type { LmaClient } from '@/services/api';

export type BaseLayer = 'satellite' | 'terrain';

const TIANDITU_ATTRIBUTION = '© 天地图';
const TIANDITU_SUBDOMAINS = ['0', '1', '2', '3', '4', '5', '6', '7'];

/** 天地图 Web 墨卡托瓦片（TILEMATRIXSET=w），坐标与 WGS84 测点一致，无需偏移换算。 */
const tiandituSource = (layer: string, token: string, maxzoom: number): SourceSpecification => ({
  type: 'raster',
  tiles: TIANDITU_SUBDOMAINS.map((subdomain) => (
    `https://t${subdomain}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`
    + `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${token}`
  )),
  tileSize: 256,
  maxzoom,
  attribution: TIANDITU_ATTRIBUTION,
});

/** 影像和地形晕渲各配一层中文注记；地形晕渲只到 14 级，更大比例尺由地图放大该级瓦片。 */
export function tiandituSources(token: string): Record<string, SourceSpecification> {
  return {
    'tianditu-img': tiandituSource('img', token, 18),
    'tianditu-img-label': tiandituSource('cia', token, 18),
    'tianditu-ter': tiandituSource('ter', token, 14),
    'tianditu-ter-label': tiandituSource('cta', token, 14),
  };
}

export const BASE_LAYER_IDS: Record<BaseLayer, string[]> = {
  satellite: ['tianditu-img', 'tianditu-img-label'],
  terrain: ['tianditu-ter', 'tianditu-ter-label'],
};

export function tiandituLayers(visible: BaseLayer) {
  return (Object.keys(BASE_LAYER_IDS) as BaseLayer[]).flatMap((base) => BASE_LAYER_IDS[base].map((source) => ({
    id: source,
    type: 'raster' as const,
    source,
    layout: { visibility: base === visible ? 'visible' as const : 'none' as const },
  })));
}

// 密钥由后端按运行配置下发，同一客户端只请求一次。
const tokenRequests = new WeakMap<LmaClient, Promise<string | null>>();

const requestToken = (client: LmaClient) => {
  let request = tokenRequests.get(client);
  if (!request) {
    request = client.getMapConfig()
      .then((config) => config.tianditu_token || null)
      .catch(() => {
        tokenRequests.delete(client);
        return null;
      });
    tokenRequests.set(client, request);
  }
  return request;
};

export type TiandituToken = { status: 'loading' } | { status: 'ready'; token: string | null };

export function useTiandituToken(): TiandituToken {
  const client = useLmaClient();
  const [state, setState] = useState<TiandituToken>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    void requestToken(client).then((token) => {
      if (active) {
        setState({ status: 'ready', token });
      }
    });
    return () => {
      active = false;
    };
  }, [client]);
  return state;
}

export const MISSING_TOKEN_NOTICE = '未配置天地图密钥，地图只显示测点位置，不加载底图。';
