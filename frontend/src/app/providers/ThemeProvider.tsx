import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'lma-theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setTheme] = useState<ThemePreference>(() => {
    // index.html 在首屏绘制前读取偏好，避免刷新时闪现另一种主题。
    const initial = document.documentElement.dataset.themePreference;
    return initial === 'light' || initial === 'dark' ? initial : 'system';
  });
  const systemIsDark = useMediaQuery('(prefers-color-scheme: dark)');
  const systemTheme = systemIsDark ? 'dark' : 'light';
  const resolvedTheme = preference === 'system' ? systemTheme : preference;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = preference;
  }, [preference, resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 浏览器禁止存储时仍允许切换，本次页面使用内存中的选择。
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('ThemeProvider is required');
  }
  return theme;
}
