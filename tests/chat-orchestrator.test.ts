import { describe, expect, it } from 'vitest';

import { TraceRecorder } from '../src/app/testing/traceRecorder';
import { ChatOrchestrator } from '../src/features/chat/orchestration/ChatOrchestrator';

describe('ChatOrchestrator', () => {
  it('fixes authorization, revision, lease, ledger, and message ordering', async () => {
    const trace = new TraceRecorder();
    const orchestrator = new ChatOrchestrator(trace);
    const lease = { id: 'lease-1' };

    const result = await orchestrator.start({
      intent: { type: 'send' },
      readRevision: () => 7,
      preflight: () => undefined,
      authorize: () => true,
      revalidate: (revision) => revision === 7,
      acquireLease: () => lease,
      releaseLease: () => undefined,
      persistStartedLedger: () => undefined,
      appendVisibleMessages: () => undefined,
    });

    expect(result).toEqual({ ok: true, lease, revision: 7 });
    trace.assertOrder([
      'chat.preflight.start',
      'chat.authorization.start',
      'chat.revision.revalidate',
      'chat.lease.acquired',
      'chat.ledger.persist.start',
      'chat.ledger.persist.done',
      'chat.messages.append',
    ]);
  });

  it('never appends or reaches a provider-ready state when ledger persistence fails', async () => {
    const trace = new TraceRecorder();
    const orchestrator = new ChatOrchestrator(trace);
    let released = false;
    let appended = false;

    const result = await orchestrator.start({
      intent: { type: 'retry', messageId: 'msg-1' },
      readRevision: () => 1,
      preflight: () => undefined,
      authorize: () => true,
      revalidate: () => true,
      acquireLease: () => ({ id: 'lease-1' }),
      releaseLease: () => {
        released = true;
      },
      persistStartedLedger: () => {
        throw new Error('disk full');
      },
      appendVisibleMessages: () => {
        appended = true;
      },
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ stage: 'ledger' });
    expect(released).toBe(true);
    expect(appended).toBe(false);
  });

  it('releases the lease when the awaited visible-message commit is rejected', async () => {
    const orchestrator = new ChatOrchestrator();
    let released = false;

    const result = await orchestrator.start({
      intent: { type: 'send' },
      readRevision: () => 2,
      preflight: () => undefined,
      authorize: () => true,
      revalidate: () => true,
      acquireLease: () => ({ id: 'lease-append' }),
      releaseLease: () => {
        released = true;
      },
      persistStartedLedger: () => undefined,
      appendVisibleMessages: async () => {
        await Promise.resolve();
        throw new Error('workspace became read-only');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      stage: 'append',
      error: { message: 'workspace became read-only' },
    });
    expect(released).toBe(true);
  });

  it('rejects stale state after authorization before acquiring a lease', async () => {
    const orchestrator = new ChatOrchestrator();
    let acquired = false;
    const result = await orchestrator.start({
      intent: { type: 'comparison', targetCount: 2 },
      readRevision: () => 4,
      preflight: () => undefined,
      authorize: () => true,
      revalidate: () => false,
      acquireLease: () => {
        acquired = true;
        return { id: 'lease-1' };
      },
      releaseLease: () => undefined,
      persistStartedLedger: () => undefined,
      appendVisibleMessages: () => undefined,
    });

    expect(result).toEqual({ ok: false, stage: 'revision' });
    expect(acquired).toBe(false);
  });
});
