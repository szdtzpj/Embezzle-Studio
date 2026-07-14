import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { ChatUsageLedger } from '../src/features/chat/internal/requests/ChatUsageLedger';

describe('ChatUsageLedger', () => {
  it('rolls back a newly inserted attempt when required durability fails', async () => {
    let workspace = createDefaultWorkspace();
    workspace = { ...workspace, costGuard: { ...workspace.costGuard, enabled: true } };
    const replacements: string[][] = [];
    let flushCount = 0;
    const ledger = new ChatUsageLedger({
      readWorkspace: () => workspace,
      isReplacing: () => false,
      replaceUsageEvents: async (events) => {
        replacements.push(events.map((event) => event.id));
        workspace = { ...workspace, providerUsageEvents: events };
        return true;
      },
      flushRequired: async () => {
        flushCount += 1;
        if (flushCount === 1) throw new Error('disk full');
      },
      confirmCost: async () => true,
      notify: () => undefined,
      now: () => 1_700_000_000_000,
    });
    const event = ledger.createStarted({
      id: 'usage-1',
      kind: 'chat',
      providerId: 'provider-1',
      modelId: 'model-1',
      createdAt: 1_700_000_000_000,
    });

    await expect(ledger.persist([event])).rejects.toThrow(/台账无法安全写入/);
    expect(replacements).toEqual([['usage-1'], []]);
    expect(workspace.providerUsageEvents).toEqual([]);
  });

  it('revalidates replacement state after a warning decision', async () => {
    const workspace = createDefaultWorkspace();
    let replacing = false;
    const ledger = new ChatUsageLedger({
      readWorkspace: () => ({
        ...workspace,
        costGuard: {
          ...workspace.costGuard,
          enabled: true,
          confirmPotentialMultipleCharges: true,
        },
      }),
      isReplacing: () => replacing,
      replaceUsageEvents: async () => true,
      flushRequired: async () => undefined,
      confirmCost: async () => {
        replacing = true;
        return true;
      },
      notify: () => undefined,
      now: () => 1_700_000_000_000,
    });

    await expect(
      ledger.authorize({
        potentialMultipleCharges: true,
        operations: [{ kind: 'chat', providerId: 'provider-1', modelId: 'model-1' }],
      })
    ).resolves.toBe(false);
  });
});
