import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';

import type { ColorMode } from '../../domain/types';
import { loadColorMode, saveColorMode } from '../../services/storage';
import { KelivoThemeProvider } from '../theme';

export interface AppearanceValue {
  colorMode: ColorMode;
  isDark: boolean;
  notice: string;
  setColorMode(mode: ColorMode): void;
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

/** Owns separately persisted color mode and exposes the resolved UI theme. */
export function AppearanceProvider(props: { children: ReactNode }): React.ReactElement {
  const systemColorScheme = useColorScheme();
  const [colorMode, setColorModeState] = useState<ColorMode>('system');
  const [notice, setNotice] = useState('');
  const changedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    loadColorMode()
      .then((savedColorMode) => {
        if (mounted && !changedRef.current) setColorModeState(savedColorMode);
      })
      .catch((error) => {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : '颜色模式加载失败。');
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setColorMode = useCallback((nextColorMode: ColorMode) => {
    changedRef.current = true;
    setColorModeState(nextColorMode);
    setNotice('');
    saveColorMode(nextColorMode).catch((error) => {
      setNotice(error instanceof Error ? error.message : '颜色模式保存失败。');
    });
  }, []);

  const isDark = colorMode === 'dark' || (colorMode === 'system' && systemColorScheme === 'dark');
  const value = useMemo<AppearanceValue>(
    () => ({ colorMode, isDark, notice, setColorMode }),
    [colorMode, isDark, notice, setColorMode]
  );

  return (
    <KelivoThemeProvider scheme={isDark ? 'dark' : 'light'}>
      <AppearanceContext.Provider value={value}>{props.children}</AppearanceContext.Provider>
    </KelivoThemeProvider>
  );
}

export function useAppearance(): AppearanceValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance requires AppearanceProvider.');
  return value;
}
