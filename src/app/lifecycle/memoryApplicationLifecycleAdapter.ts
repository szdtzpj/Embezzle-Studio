import type {
  ApplicationLifecycleEvent,
  ApplicationLifecycleListener,
  ApplicationLifecyclePort,
} from './applicationLifecyclePort';

export class MemoryApplicationLifecycleAdapter implements ApplicationLifecyclePort {
  private state: ApplicationLifecycleEvent = 'foreground';
  private readonly listeners = new Set<ApplicationLifecycleListener>();

  getState(): ApplicationLifecycleEvent {
    return this.state;
  }

  subscribe(listener: ApplicationLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test control: emit a lifecycle transition. */
  emit(event: ApplicationLifecycleEvent): void {
    this.state = event;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
