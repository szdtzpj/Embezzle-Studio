import type { TraceRecorder } from '../../../app/testing/traceRecorder';
import type { ChatIntent } from './chatIntents';

export type ChatStartResult<Lease> =
  | { ok: true; lease: Lease; revision: number }
  | {
      ok: false;
      stage: 'preflight' | 'authorization' | 'revision' | 'lease' | 'ledger' | 'append';
      error?: Error;
    };

export interface ChatStartPlan<Lease> {
  intent: ChatIntent;
  readRevision(): number;
  preflight(): void | Promise<void>;
  authorize(): boolean | Promise<boolean>;
  revalidate(expectedRevision: number): boolean | Promise<boolean>;
  acquireLease(): Lease | null;
  releaseLease(lease: Lease): void;
  persistStartedLedger(): void | Promise<void>;
  appendVisibleMessages(): void | Promise<void>;
}

/**
 * Owns the invariant-bearing start of every provider request lifecycle.
 * Callers provide feature-specific validation and records, but cannot reorder
 * cost authorization, revision revalidation, the single lease, durable ledger,
 * and visible-message commit.
 */
export class ChatOrchestrator {
  constructor(private readonly trace?: TraceRecorder) {}

  async start<Lease>(plan: ChatStartPlan<Lease>): Promise<ChatStartResult<Lease>> {
    const revision = plan.readRevision();
    this.trace?.record('chat.preflight.start', { intent: plan.intent.type, revision });
    try {
      await plan.preflight();
    } catch (error) {
      this.trace?.record('chat.preflight.rejected', { intent: plan.intent.type });
      return { ok: false, stage: 'preflight', error: asError(error) };
    }

    this.trace?.record('chat.authorization.start', { intent: plan.intent.type });
    if (!(await plan.authorize())) {
      this.trace?.record('chat.authorization.rejected', { intent: plan.intent.type });
      return { ok: false, stage: 'authorization' };
    }

    this.trace?.record('chat.revision.revalidate', { revision });
    if (!(await plan.revalidate(revision))) {
      return { ok: false, stage: 'revision' };
    }

    const lease = plan.acquireLease();
    if (!lease) {
      this.trace?.record('chat.lease.rejected', { intent: plan.intent.type });
      return { ok: false, stage: 'lease' };
    }
    this.trace?.record('chat.lease.acquired', { intent: plan.intent.type });

    try {
      this.trace?.record('chat.ledger.persist.start', { intent: plan.intent.type });
      await plan.persistStartedLedger();
      this.trace?.record('chat.ledger.persist.done', { intent: plan.intent.type });
    } catch (error) {
      plan.releaseLease(lease);
      this.trace?.record('chat.ledger.persist.failed', { intent: plan.intent.type });
      return { ok: false, stage: 'ledger', error: asError(error) };
    }

    try {
      this.trace?.record('chat.messages.append', { intent: plan.intent.type });
      await plan.appendVisibleMessages();
    } catch (error) {
      plan.releaseLease(lease);
      return { ok: false, stage: 'append', error: asError(error) };
    }

    return { ok: true, lease, revision };
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
