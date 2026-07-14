/**
 * Controllable clock for ordering tests. Advances only when tests call tick/advance.
 */
export interface FakeTimerHandle {
  id: number;
  dueAt: number;
  callback: () => void;
  cleared: boolean;
}

export class FakeClock {
  private current = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, FakeTimerHandle>();

  now(): number {
    return this.current;
  }

  setTime(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    const target = this.current + ms;
    this.runDueTimers(target);
    this.current = target;
  }

  tick(ms: number): void {
    this.advance(ms);
  }

  setTimeout(callback: () => void, delayMs: number): { clear(): void } {
    const id = this.nextTimerId++;
    const handle: FakeTimerHandle = {
      id,
      dueAt: this.current + Math.max(0, delayMs),
      callback,
      cleared: false,
    };
    this.timers.set(id, handle);
    return {
      clear: () => {
        handle.cleared = true;
        this.timers.delete(id);
      },
    };
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  private runDueTimers(until: number): void {
    // Fire timers in due order, including timers scheduled by earlier callbacks
    // as long as they remain due at or before `until`.
    for (;;) {
      let next: FakeTimerHandle | null = null;
      for (const handle of this.timers.values()) {
        if (handle.cleared || handle.dueAt > until) {
          continue;
        }
        if (!next || handle.dueAt < next.dueAt || (handle.dueAt === next.dueAt && handle.id < next.id)) {
          next = handle;
        }
      }
      if (!next) {
        break;
      }
      this.timers.delete(next.id);
      this.current = next.dueAt;
      next.callback();
    }
  }
}
