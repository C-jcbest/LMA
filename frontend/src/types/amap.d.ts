import '@amap/amap-jsapi-types';

// 官方类型包未声明这两个加载器插件和容器尺寸监听选项。
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
