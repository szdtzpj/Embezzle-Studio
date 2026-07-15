import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';

import {
  useWorkspaceSelector,
  useWorkspaceStatus,
} from '../../app/workspace/WorkspaceSessionProvider';
import { useWorkspaceSession } from '../../app/workspace/internal/WorkspaceSessionContext';
import {
  applyGenerationTaskOutboxToSession,
  ensureGenerationTaskBackgroundRegistration,
  runDueGenerationTaskQueries,
  type GenerationTaskRecoveryResult,
} from '../../services/generationTaskBackground';
import { installGenerationTaskNotificationHandler } from '../../services/generationTaskNotifications';

export interface GenerationTaskBackgroundContextValue {
  recoverNow(): Promise<GenerationTaskRecoveryResult | undefined>;
  applying: boolean;
}

const GenerationTaskBackgroundContext = createContext<GenerationTaskBackgroundContextValue | null>(null);

/**
 * App-level bridge for persisted generation tasks. It owns no visual state and
 * can be mounted above the mobile shell. The shell can call recoverNow after a
 * user returns from a task center or a notification response.
 */
export function GenerationTaskBackgroundProvider(props: {
  children: ReactNode;
  /** Pause foreground recovery while an interactive provider request is active. */
  suspended?: boolean;
}): React.ReactElement {
  const session = useWorkspaceSession();
  const status = useWorkspaceStatus();
  const conversations = useWorkspaceSelector((workspace) => workspace.conversations);
  const suspended = props.suspended === true;
  const applyingRef = useRef(false);
  const [applying, setApplying] = useState(false);
  const recoveryRef = useRef<Promise<GenerationTaskRecoveryResult | undefined> | null>(null);

  useEffect(() => {
    installGenerationTaskNotificationHandler();
  }, []);

  const applyOutbox = useCallback(async () => {
    if (status.phase !== 'ready' || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      await applyGenerationTaskOutboxToSession(session);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [session, status.phase]);

  const recoverNow = useCallback(async (): Promise<GenerationTaskRecoveryResult | undefined> => {
    if (Platform.OS === 'web' || status.phase !== 'ready' || suspended) return undefined;
    if (recoveryRef.current) return recoveryRef.current;
    const promise = (async () => {
      await applyOutbox();
      const recovery = await runDueGenerationTaskQueries(session.getSnapshot());
      await applyOutbox();
      return recovery;
    })();
    recoveryRef.current = promise;
    try {
      return await promise;
    } finally {
      if (recoveryRef.current === promise) recoveryRef.current = null;
    }
  }, [applyOutbox, session, status.phase, suspended]);

  // Keep the single persistent WorkManager task in sync with the current
  // workspace, without issuing provider requests on every render.
  useEffect(() => {
    if (status.phase !== 'ready') return;
    void ensureGenerationTaskBackgroundRegistration({
      ...session.getSnapshot(),
      conversations,
    }).catch(() => {
      // Registration is best effort. A rejected TaskManager/WorkManager call
      // must not become an unhandled promise rejection in the UI runtime.
    });
  }, [conversations, session, status.phase]);

  // Apply headless results and perform one due query when the app returns to
  // the foreground. The nextCheckAt metadata prevents rapid duplicate calls.
  useEffect(() => {
    if (Platform.OS === 'web' || status.phase !== 'ready' || suspended) return;
    void recoverNow().catch(() => {
      // Recovery is retried on the next foreground transition. Never let a
      // provider/network failure escape from this fire-and-forget effect.
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void recoverNow().catch(() => {
          // Keep the failure local; the persisted task remains eligible for a
          // later recovery pass.
        });
      }
    });
    return () => subscription.remove();
  }, [recoverNow, status.phase, suspended]);

  const value = useMemo<GenerationTaskBackgroundContextValue>(
    () => ({ recoverNow, applying }),
    [applying, recoverNow]
  );
  return (
    <GenerationTaskBackgroundContext.Provider value={value}>
      {props.children}
    </GenerationTaskBackgroundContext.Provider>
  );
}

export function useGenerationTaskBackground(): GenerationTaskBackgroundContextValue {
  const value = useContext(GenerationTaskBackgroundContext);
  if (!value) {
    throw new Error('useGenerationTaskBackground requires GenerationTaskBackgroundProvider.');
  }
  return value;
}
