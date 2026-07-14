import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import type {
  ApplicationLifecycleEvent,
  ApplicationLifecycleListener,
  ApplicationLifecyclePort,
} from './applicationLifecyclePort';

function toLifecycleEvent(status: AppStateStatus): ApplicationLifecycleEvent {
  return status === 'active' ? 'foreground' : 'background';
}

/**
 * Production lifecycle adapter over React Native AppState.
 */
export function createExpoApplicationLifecycleAdapter(): ApplicationLifecyclePort {
  let current = toLifecycleEvent(AppState.currentState);
  const listeners = new Set<ApplicationLifecycleListener>();
  let subscription: NativeEventSubscription | null = null;

  function ensureSubscribed(): void {
    if (subscription) {
      return;
    }
    subscription = AppState.addEventListener('change', (nextState) => {
      const event = toLifecycleEvent(nextState);
      if (event === current) {
        return;
      }
      current = event;
      for (const listener of listeners) {
        listener(event);
      }
    });
  }

  return {
    getState(): ApplicationLifecycleEvent {
      return current;
    },
    subscribe(listener: ApplicationLifecycleListener): () => void {
      ensureSubscribed();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && subscription) {
          subscription.remove();
          subscription = null;
        }
      };
    },
  };
}
