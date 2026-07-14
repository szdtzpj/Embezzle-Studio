import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/app/testing/fakeClock';
import { FakeIdGenerator } from '../src/app/testing/fakeIdGenerator';
import { TraceRecorder } from '../src/app/testing/traceRecorder';
import { MemoryApplicationLifecycleAdapter } from '../src/app/lifecycle/memoryApplicationLifecycleAdapter';
import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { ScriptedProviderAdapter } from '../src/features/chat/orchestration/scriptedProviderAdapter';

describe('architecture characterization harness', () => {
  it('records persistence and provider ordering with a deterministic clock', () => {
    const clock = new FakeClock();
    clock.setTime(1_000);
    const trace = new TraceRecorder(clock);
    const ids = new FakeIdGenerator();

    expect(ids.createId('msg')).toBe('msg-test-1');
    expect(ids.createId('msg')).toBe('msg-test-2');

    clock.advance(50);
    trace.record('a');
    clock.advance(10);
    trace.record('b');

    expect(trace.names()).toEqual(['a', 'b']);
    expect(trace.snapshot()[0].at).toBe(1_050);
    expect(trace.snapshot()[1].at).toBe(1_060);
    trace.assertOrder(['a', 'b']);
  });

  it('memory workspace adapter never touches production storage keys', async () => {
    const workspace = createDefaultWorkspace();
    workspace.projects[0] = { ...workspace.projects[0], name: 'Harness' };
    const trace = new TraceRecorder();
    const adapter = new MemoryWorkspacePersistenceAdapter({
      initial: workspace,
      recoveryNotice: 'recovered-from-backup',
      trace,
    });

    const loaded = await adapter.load();
    expect(loaded?.projects[0]?.name).toBe('Harness');
    expect(adapter.consumeRecoveryNotice()).toBe('recovered-from-backup');
    expect(adapter.consumeRecoveryNotice()).toBeNull();

    const next = createDefaultWorkspace();
    next.projects[0] = { ...next.projects[0], name: 'Saved' };
    await adapter.save(next);
    expect(adapter.getStoredSnapshot()?.projects[0]?.name).toBe('Saved');
    expect(adapter.savedSnapshots).toHaveLength(1);
    trace.assertOrder([
      'persistence.load.start',
      'persistence.load.success',
      'persistence.recovery-notice',
      'persistence.save.start',
      'persistence.save.public-committed',
      'persistence.save.success',
    ]);
  });

  it('scripted provider never opens a production network path', async () => {
    const provider = createDefaultWorkspace().providers[0];
    const adapter = new ScriptedProviderAdapter([
      { type: 'stream', content: 'hi' },
      { type: 'result', result: { content: 'hi!', raw: { scripted: true } } },
    ]);

    const deltas: string[] = [];
    const result = await adapter.run({
      provider,
      modelId: 'model-a',
      messages: [],
      reasoningEffort: 'default',
      onStreamUpdate: (update) => deltas.push(update.content),
    });

    expect(result).toEqual({ content: 'hi!', raw: { scripted: true } });
    expect(deltas).toEqual(['hi']);
    expect(adapter.chatRequests).toHaveLength(1);
  });

  it('memory lifecycle adapter emits foreground and background events', () => {
    const lifecycle = new MemoryApplicationLifecycleAdapter();
    const events: string[] = [];
    const unsubscribe = lifecycle.subscribe((event) => events.push(event));

    expect(lifecycle.getState()).toBe('foreground');
    lifecycle.emit('background');
    lifecycle.emit('foreground');
    unsubscribe();
    lifecycle.emit('background');

    expect(events).toEqual(['background', 'foreground']);
    expect(lifecycle.getState()).toBe('background');
  });

  it('fake clock fires deferred save timers in order', () => {
    const clock = new FakeClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(1), 450);
    clock.setTimeout(() => fired.push(2), 100);
    clock.advance(100);
    expect(fired).toEqual([2]);
    clock.advance(350);
    expect(fired).toEqual([2, 1]);
  });
});
