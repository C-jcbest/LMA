import '@amap/amap-jsapi-types';

declare global {
  namespace AMap {
    interface MapOptions {
      resizeEnable?: boolean;
    }
    class ToolBar extends Control {
      constructor(options?: { position?: string });
    }
    class Scale extends Control {
      constructor();
    }
  }
}
