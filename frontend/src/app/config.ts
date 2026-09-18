/**
 * LMA 应用全局运行配置
 */

export const LMA_ASSISTANT_ID = 'lma-agent';
export const TITLE_ASSISTANT_ID = 'session-title';

const STORAGE_KEY_CONFIG = 'lma_langgraph_config';
const DEFAULT_DEV_API_URL = 'http://127.0.0.1:2024';

/**
 * 获取当前 LangGraph API 地址
 * 生产环境优先走同源反向代理 /langgraph-api，开发环境优先走本地配置或默认端口 2024
 */
export function getApiUrl(): string {
  if (import.meta.env.PROD) {
    return import.meta.env.VITE_LANGGRAPH_API_URL || '/langgraph-api';
  }
  return localStorage.getItem(STORAGE_KEY_CONFIG) || import.meta.env.VITE_LANGGRAPH_API_URL || DEFAULT_DEV_API_URL;
}

export function setStoredDevApiUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY_CONFIG, url);
}
