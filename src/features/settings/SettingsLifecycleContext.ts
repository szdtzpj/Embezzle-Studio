import { createContext, type RefObject } from 'react';

import type { SettingsScreenHandle } from './internal/SettingsScreen';
import type { SettingsDestination } from '../../app/navigation/settingsNavigation';

export interface SettingsLauncher {
  isOpen: boolean;
  hasMounted: boolean;
  open(destination?: SettingsDestination): void;
  close(): void;
  /** Returns true when Settings consumed the back gesture. */
  back(): boolean;
}

export interface SettingsLifecycleContextValue {
  launcher: SettingsLauncher;
  settingsScreenRef: RefObject<SettingsScreenHandle | null>;
}

export const SettingsLifecycleContext =
  createContext<SettingsLifecycleContextValue | null>(null);
