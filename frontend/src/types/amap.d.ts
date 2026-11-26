import '@amap/amap-jsapi-types';

declare global {
  namespace AMap {
    interface MapOptions {
      resizeEnable?: boolean;
      mapStyle?: string;
    }
    interface Map {
      setMapStyle?(style: string): void;
    }
    const createDefaultLayer: (() => Layer) | undefined;
    class Scale extends Control {
      constructor(options?: { position?: string; offset?: [number, number] });
    }
  }
}
