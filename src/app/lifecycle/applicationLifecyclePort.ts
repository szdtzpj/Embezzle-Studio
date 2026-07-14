export type ApplicationLifecycleEvent = 'foreground' | 'background';

export type ApplicationLifecycleListener = (event: ApplicationLifecycleEvent) => void;

/**
 * Point-to-point port for app foreground/background transitions.
 * Production uses Expo AppState; tests use the memory adapter.
 */
export interface ApplicationLifecyclePort {
  getState(): ApplicationLifecycleEvent;
  subscribe(listener: ApplicationLifecycleListener): () => void;
}
