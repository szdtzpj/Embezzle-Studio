import { useContext } from 'react';

import {
  SettingsLifecycleContext,
  type SettingsLauncher,
} from './SettingsLifecycleContext';

export type { SettingsLauncher };

export function useSettingsLauncher(): SettingsLauncher {
  const value = useContext(SettingsLifecycleContext);
  if (!value) {
    throw new Error('useSettingsLauncher requires SettingsProductivityProvider.');
  }
  return value.launcher;
}
