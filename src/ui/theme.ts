import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import { Platform, StyleSheet } from 'react-native';

export type KelivoColorScheme = 'light' | 'dark';

const lightColors = Object.freeze({
  primary: '#4D5C92',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DCE1FF',
  onPrimaryContainer: '#03174B',
  accent: '#4D5C92',
  accentPressed: '#3D4B7A',
  accentSoft: '#DCE1FF',
  accentBorder: '#C6D0FF',
  accentText: '#4D5C92',
  textOnAccent: '#FFFFFF',
  warning: '#D97706',
  onWarning: '#202020',
  warningContainer: 'rgba(245, 158, 11, 0.10)',
  warningBorder: 'rgba(217, 119, 6, 0.22)',
  success: '#16A34A',
  successContainer: 'rgba(34, 197, 94, 0.12)',
  borderStrong: 'rgba(0, 0, 0, 0.14)',
  secondary: '#595D72',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#DEE1F9',
  onSecondaryContainer: '#161B2C',
  tertiary: '#75546F',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#FFD7F6',
  onTertiaryContainer: '#2C122A',
  background: '#FFFFFF',
  surface: '#F7F7F7',
  surfaceAlt: '#FFFFFF',
  surfaceSunken: '#EFEFEF',
  onSurface: '#202020',
  onSurfaceVariant: '#646464',
  outline: 'rgba(0, 0, 0, 0.10)',
  outlineVariant: 'rgba(0, 0, 0, 0.05)',
  divider: 'rgba(0, 0, 0, 0.06)',
  text: '#202020',
  textSecondary: '#646464',
  textTertiary: '#9A9A9A',
  textMuted: '#9A9A9A',
  textOnPrimary: '#FFFFFF',
  card: '#FFFFFF',
  surfacePressed: 'rgba(0, 0, 0, 0.05)',
  inverseSurface: '#121213',
  onInverseSurface: '#F9F9F9',
  error: '#BB0947',
  onError: '#FFFFFF',
  errorContainer: '#FDDADE',
  onErrorContainer: '#400013',
  shadow: 'rgba(0, 0, 0, 0.05)',
  scrim: 'rgba(0, 0, 0, 0.32)',
  userBubble: '#F3F4F6',
  userBubbleBorder: '#E5E7EB',
  assistantBubble: '#FFFFFF',
  reasoningCard: '#F0F4FF',
  reasoningCardBorder: '#E0E7FF',
  toolCard: '#F0F4FF',
  citationBadge: '#F0F4FF',
  composer: '#FFFFFF',
  composerBorder: 'rgba(0, 0, 0, 0.08)',
  placeholder: '#9CA3AF',
});

export type KelivoColors = Readonly<Record<keyof typeof lightColors, string>>;

const darkColors: KelivoColors = Object.freeze({
  primary: '#B8C4FF',
  onPrimary: '#1E2A5A',
  primaryContainer: '#354271',
  onPrimaryContainer: '#DCE1FF',
  accent: '#B8C4FF',
  accentPressed: '#CAD2FF',
  accentSoft: '#2D375D',
  accentBorder: '#53618D',
  accentText: '#B8C4FF',
  textOnAccent: '#1E2A5A',
  warning: '#FFB95F',
  onWarning: '#202020',
  warningContainer: 'rgba(255, 185, 95, 0.14)',
  warningBorder: 'rgba(255, 185, 95, 0.30)',
  success: '#6DD58C',
  successContainer: 'rgba(109, 213, 140, 0.14)',
  borderStrong: 'rgba(255, 255, 255, 0.20)',
  secondary: '#C1C5DD',
  onSecondary: '#2A2E42',
  secondaryContainer: '#404458',
  onSecondaryContainer: '#DEE1F9',
  tertiary: '#E4BADA',
  onTertiary: '#43263F',
  tertiaryContainer: '#5B3D56',
  onTertiaryContainer: '#FFD7F6',
  background: '#101217',
  surface: '#14161C',
  surfaceAlt: '#1B1D24',
  surfaceSunken: '#0E1015',
  onSurface: '#E5E7EF',
  onSurfaceVariant: '#B8BBC6',
  outline: 'rgba(255, 255, 255, 0.13)',
  outlineVariant: 'rgba(255, 255, 255, 0.08)',
  divider: 'rgba(255, 255, 255, 0.08)',
  text: '#E5E7EF',
  textSecondary: '#B8BBC6',
  textTertiary: '#878A95',
  textMuted: '#878A95',
  textOnPrimary: '#1E2A5A',
  card: '#1B1D24',
  surfacePressed: 'rgba(255, 255, 255, 0.07)',
  inverseSurface: '#F1F1F5',
  onInverseSurface: '#202126',
  error: '#FFB1C2',
  onError: '#65002B',
  errorContainer: '#5B1130',
  onErrorContainer: '#FFD9E1',
  shadow: 'rgba(0, 0, 0, 0.36)',
  scrim: 'rgba(0, 0, 0, 0.62)',
  userBubble: '#242731',
  userBubbleBorder: '#343844',
  assistantBubble: '#1B1D24',
  reasoningCard: '#222942',
  reasoningCardBorder: '#394469',
  toolCard: '#222942',
  citationBadge: '#222942',
  composer: '#1B1D24',
  composerBorder: 'rgba(255, 255, 255, 0.11)',
  placeholder: '#878A95',
});

const radius = Object.freeze({
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
});

const spacing = Object.freeze({
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
});

function createTypography(colors: KelivoColors) {
  return Object.freeze({
    title: Object.freeze({
      fontSize: 16,
      fontWeight: '600' as const,
      lineHeight: 22,
      color: colors.text,
    }),
    subtitle: Object.freeze({
      fontSize: 11,
      fontWeight: '500' as const,
      lineHeight: 16,
      color: colors.textSecondary,
    }),
    body: Object.freeze({
      fontSize: 15,
      fontWeight: '400' as const,
      lineHeight: 24,
      color: colors.text,
    }),
    caption: Object.freeze({
      fontSize: 12,
      fontWeight: '500' as const,
      lineHeight: 17,
      color: colors.textSecondary,
    }),
    button: Object.freeze({
      fontSize: 14,
      fontWeight: '600' as const,
      lineHeight: 20,
    }),
  });
}

function createShadows(dark: boolean) {
  return Object.freeze({
    soft: Object.freeze({
      shadowColor: '#000000',
      shadowOffset: Object.freeze({ width: 0, height: 6 }),
      shadowOpacity: dark ? 0.22 : 0.05,
      shadowRadius: 18,
      elevation: 6,
    }),
    medium: Object.freeze({
      shadowColor: '#000000',
      shadowOffset: Object.freeze({ width: 0, height: 8 }),
      shadowOpacity: dark ? 0.28 : 0.08,
      shadowRadius: 24,
      elevation: 10,
    }),
    sheet: Object.freeze({
      shadowColor: '#000000',
      shadowOffset: Object.freeze({ width: 0, height: -6 }),
      shadowOpacity: dark ? 0.30 : 0.08,
      shadowRadius: 24,
      elevation: 16,
    }),
  });
}

function createKelivoTheme(scheme: KelivoColorScheme, colors: KelivoColors) {
  const dark = scheme === 'dark';
  return Object.freeze({
    scheme,
    dark,
    colors,
    radius,
    spacing,
    typography: createTypography(colors),
    shadows: createShadows(dark),
  });
}

export type KelivoTheme = ReturnType<typeof createKelivoTheme>;

export const lightKelivoTheme = createKelivoTheme('light', lightColors);
export const darkKelivoTheme = createKelivoTheme('dark', darkColors);

export const kelivoThemes = Object.freeze({
  light: lightKelivoTheme,
  dark: darkKelivoTheme,
});

/** @deprecated Prefer useKelivoTheme inside React components. */
export const kelivo = lightKelivoTheme;

const KelivoThemeContext = createContext<KelivoTheme>(lightKelivoTheme);

export interface KelivoThemeProviderProps {
  scheme: KelivoColorScheme;
  children: ReactNode;
}

export function KelivoThemeProvider({ scheme, children }: KelivoThemeProviderProps) {
  return createElement(
    KelivoThemeContext.Provider,
    { value: kelivoThemes[scheme] },
    children,
  );
}

export function useKelivoTheme(): KelivoTheme {
  return useContext(KelivoThemeContext);
}

export const fontFallback = Platform.select({
  ios: ['PingFang SC', 'Hiragino Sans GB', 'Roboto'],
  android: ['sans-serif'],
  default: ['PingFang SC', 'Microsoft YaHei', 'Segoe UI', 'Roboto', 'sans-serif'],
});

export const themeStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: {
    flex: 1,
  },
  shrink: {
    flexShrink: 1,
    minWidth: 0,
  },
});
