import { describe, expect, it, vi } from 'vitest';

import type {
  ChatLease,
  ChatOrchestrationController,
} from '../src/features/chat/internal/ChatContext';
import {
  bindTaskLeaseAbort,
  ChatTaskLeaseCoordinator,
} from '../src/features/chat/orchestration/ChatTaskLease';

function coordinatorHarness() {
  let current: ChatLease | null = null;
  const finish = vi.fn((lease: ChatLease) => {
    if (current === lease) current = null;
  });
  const orchestration: ChatOrchestrationController = {
    current: () => current,
    begin: (options) => {
      if (current) return null;
      current = {
        controller: new AbortController(),
        label: options.label,
        phase: options.phase,
        mcpActive: options.mcpActive === true,
      };
      return current;
    },
    transition: (lease, phase) => {
      if (current !== lease || lease.controller.signal.aborted) return false;
      lease.phase = phase;
      return true;
    },
    finish,
    stop: () => current?.controller.abort(),
  };
  const snapshots: Array<Readonly<Record<string, boolean>>> = [];
  const coordinator = new ChatTaskLeaseCoordinator(orchestration, (snapshot) => {
    snapshots.push(snapshot);
  });
  return { coordinator, finish, orchestration, snapshots };
}

function started(
  result: ReturnType<ChatTaskLeaseCoordinator['start']>
): Extract<typeof result, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected task query to start, got ${result.busyLabel}.`);
  return result;
}

describe('Chat task lease cancellation', () => {
  it('forwards the shared lease abort exactly once', () => {
    const lease = new AbortController();
    const onAbort = vi.fn();
    bindTaskLeaseAbort(lease.signal, onAbort);

    lease.abort();
    lease.abort();

    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('can unlink a finished lease without cancelling later work', () => {
    const lease = new AbortController();
    const onAbort = vi.fn();
    const unlink = bindTaskLeaseAbort(lease.signal, onAbort);

    unlink();
    lease.abort();

    expect(onAbort).not.toHaveBeenCalled();
  });

  it('cancels immediately when registration sees an already-aborted lease', () => {
    const lease = new AbortController();
    lease.abort();
    const onAbort = vi.fn();

    bindTaskLeaseAbort(lease.signal, onAbort);

    expect(onAbort).toHaveBeenCalledOnce();
  });
});

describe('Chat task lease coordination', () => {
  it('keeps the shared lease until the final concurrent query finishes', () => {
    const { coordinator, finish, orchestration, snapshots } = coordinatorHarness();
    const first = started(coordinator.start('message-1'));
    const second = started(coordinator.start('message-2'));

    coordinator.finish('message-1', first.controller);

    expect(finish).not.toHaveBeenCalled();
    expect(orchestration.current()).not.toBeNull();
    expect(snapshots.at(-1)).toEqual({ 'message-2': true });

    coordinator.finish('message-2', second.controller);

    expect(finish).toHaveBeenCalledOnce();
    expect(orchestration.current()).toBeNull();
    expect(snapshots.at(-1)).toEqual({});
  });

  it('does not let a replaced same-message query finish the new query lease', () => {
    const { coordinator, finish, snapshots } = coordinatorHarness();
    const replaced = started(coordinator.start('message-1'));
    const active = started(coordinator.start('message-1'));

    expect(replaced.controller.signal.aborted).toBe(true);
    coordinator.finish('message-1', replaced.controller);

    expect(finish).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual({ 'message-1': true });

    coordinator.finish('message-1', active.controller);

    expect(finish).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)).toEqual({});
  });

  it('forwards a global lease abort to every child and finishes exactly once', () => {
    const { coordinator, finish, orchestration, snapshots } = coordinatorHarness();
    const first = started(coordinator.start('message-1'));
    const second = started(coordinator.start('message-2'));
    const lease = orchestration.current();
    expect(lease).not.toBeNull();

    lease?.controller.abort();

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(orchestration.current()).toBeNull();
    expect(snapshots.at(-1)).toEqual({});

    coordinator.finish('message-1', first.controller);
    coordinator.finish('message-2', second.controller);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('cancels all child work through the public stop path', () => {
    const { coordinator, finish, orchestration } = coordinatorHarness();
    const task = started(coordinator.start('message-1'));

    coordinator.cancelAll();

    expect(task.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(orchestration.current()).toBeNull();
  });

  it('disposes without publishing state after unmount and ignores late completion', () => {
    const { coordinator, finish, snapshots } = coordinatorHarness();
    const task = started(coordinator.start('message-1'));
    const snapshotCount = snapshots.length;

    coordinator.dispose();
    coordinator.finish('message-1', task.controller);

    expect(task.controller.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(snapshots).toHaveLength(snapshotCount);
    expect(coordinator.start('message-2')).toEqual({
      ok: false,
      busyLabel: '媒体任务中心',
    });
  });

  it('reports the active operation when another lease owns Chat', () => {
    const { coordinator, orchestration } = coordinatorHarness();
    orchestration.begin({ phase: 'audio', label: '语音转写' });

    expect(coordinator.start('message-1')).toEqual({
      ok: false,
      busyLabel: '语音转写',
    });
  });
});
