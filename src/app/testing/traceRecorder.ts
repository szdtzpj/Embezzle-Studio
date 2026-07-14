/**
 * Deterministic event recorder for persistence and provider-request ordering tests.
 * Production code never imports this module.
 */
export interface TraceEvent {
  name: string;
  at: number;
  detail?: unknown;
}

export interface TraceClock {
  now(): number;
}

export class TraceRecorder {
  private readonly events: TraceEvent[] = [];
  private readonly clock: TraceClock;

  constructor(clock: TraceClock = { now: () => Date.now() }) {
    this.clock = clock;
  }

  record(name: string, detail?: unknown): void {
    this.events.push({
      name,
      at: this.clock.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  clear(): void {
    this.events.length = 0;
  }

  snapshot(): readonly TraceEvent[] {
    return this.events.slice();
  }

  names(): string[] {
    return this.events.map((event) => event.name);
  }

  indexOf(name: string, fromIndex = 0): number {
    return this.names().indexOf(name, fromIndex);
  }

  /** Asserts that each name appears in order (not necessarily consecutive). */
  assertOrder(expected: readonly string[]): void {
    let cursor = 0;
    for (const name of expected) {
      const next = this.indexOf(name, cursor);
      if (next < 0) {
        throw new Error(
          `Trace missing "${name}" after index ${cursor}. Events: ${this.names().join(' → ')}`
        );
      }
      cursor = next + 1;
    }
  }
}
