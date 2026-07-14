/**
 * Deterministic ID generator for architecture tests.
 */
export interface IdGenerator {
  createId(prefix: string): string;
}

export class FakeIdGenerator implements IdGenerator {
  private sequence = 0;

  constructor(private readonly prefixOverride?: string) {}

  createId(prefix: string): string {
    this.sequence += 1;
    const base = this.prefixOverride ?? prefix;
    return `${base}-test-${this.sequence}`;
  }

  reset(): void {
    this.sequence = 0;
  }
}

export const productionIdGenerator: IdGenerator = {
  createId(prefix: string): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  },
};
