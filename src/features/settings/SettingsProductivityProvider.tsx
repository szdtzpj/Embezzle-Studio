import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isWorkspaceCommitRejectedError } from '../../app/workspace/WorkspaceSession';
import { useWorkspaceSession } from '../../app/workspace/internal/WorkspaceSessionContext';
import type { SettingsScreenHandle } from './internal/SettingsScreen';
import {
  SettingsLifecycleContext,
  type SettingsLauncher,
} from './SettingsLifecycleContext';
import type { SettingsDestination } from '../../app/navigation/settingsNavigation';
import { SettingsWorkspaceRuntime } from './internal/SettingsWorkspaceRuntime';

export interface SettingsProductivityProviderProps {
  children: ReactNode;
}

interface SettingsLifecycleCommit {
  execute(command: { type: 'provider.ensure-active-enabled' }): Promise<unknown>;
}

function reportUnexpectedSettingsCloseCommitError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Settings close reconciliation failed: ${message}`);
}

/**
 * Settles the best-effort reconciliation triggered when Settings closes.
 * Workspace phase rejections are expected during boot, read-only recovery,
 * and backup replacement; unexpected failures are reported without leaking an
 * unhandled rejection from the fire-and-forget UI callback.
 */
export async function attemptSettingsCloseCommit(
  lifecycleCommit: SettingsLifecycleCommit,
  reportUnexpectedError: (error: unknown) => void = reportUnexpectedSettingsCloseCommitError
): Promise<void> {
  try {
    await lifecycleCommit.execute({ type: 'provider.ensure-active-enabled' });
  } catch (error) {
    if (isWorkspaceCommitRejectedError(error)) {
      return;
    }
    reportUnexpectedError(error);
  }
}

/**
 * Owns Settings mounted/visible lifecycle and public launcher.
 * Settings drafts and tools live under SettingsPane / internal modules.
 */
export function SettingsProductivityProvider(
  props: SettingsProductivityProviderProps
): React.ReactElement {
  const { children } = props;
  const workspaceSession = useWorkspaceSession();
  const [isOpen, setIsOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const settingsScreenRef = useRef<SettingsScreenHandle | null>(null);
  // State (rather than a ref) is intentional: calling open(destination) while
  // Settings is already visible must retrigger the navigation effect.
  const [pendingDestination, setPendingDestination] =
    useState<SettingsDestination | null>(null);
  const lifecycleCommit = useMemo(
    () => new SettingsWorkspaceRuntime(workspaceSession),
    [workspaceSession]
  );

  const close = useCallback(() => {
    const wasOpen = isOpen;
    settingsScreenRef.current?.resetNavigation();
    setPendingDestination(null);
    setIsOpen(false);
    if (wasOpen) {
      void attemptSettingsCloseCommit(lifecycleCommit);
    }
  }, [isOpen, lifecycleCommit]);

  const open = useCallback(
    (destination?: SettingsDestination) => {
      if (destination && destination.kind !== 'home') {
        setPendingDestination(destination);
      } else {
        setPendingDestination(null);
      }
      setHasMounted(true);
      setIsOpen(true);
    },
    []
  );

  const back = useCallback(() => {
    if (!isOpen) {
      return false;
    }
    if (settingsScreenRef.current?.handleBack()) {
      return true;
    }
    close();
    return true;
  }, [close, isOpen]);

  const launcher = useMemo<SettingsLauncher>(
    () => ({
      isOpen,
      hasMounted,
      open,
      close,
      back,
    }),
    [back, close, hasMounted, isOpen, open]
  );

  useEffect(() => {
    if (!isOpen || !hasMounted || !pendingDestination) {
      return;
    }
    const settings = settingsScreenRef.current;
    if (!settings) {
      return;
    }
    const destination = pendingDestination;
    setPendingDestination(null);
    if (destination.kind === 'providers') {
      settings.openProviders();
    } else if (destination.kind === 'provider-models') {
      void (destination.providerId
        ? settings.openProviderModels(destination.providerId)
        : settings.openActiveProviderModels());
    } else if (destination.kind === 'tool') {
      settings.openToolsSection(destination.tool);
    }
  }, [hasMounted, isOpen, pendingDestination]);

  const value = useMemo(
    () => ({
      launcher,
      settingsScreenRef,
    }),
    [launcher]
  );

  return (
    <SettingsLifecycleContext.Provider value={value}>
      {children}
    </SettingsLifecycleContext.Provider>
  );
}

export function useSettingsScreenRef(): React.RefObject<SettingsScreenHandle | null> {
  const value = React.useContext(SettingsLifecycleContext);
  if (!value) {
    throw new Error('useSettingsScreenRef requires SettingsProductivityProvider.');
  }
  return value.settingsScreenRef;
}
