import { describe, expect, it } from 'vitest';

import type {
  CostEstimate,
  CostGuardSettings,
  ProviderUsageEvent,
} from '../src/domain/types';
import {
  completeProviderUsageEvent,
  createStartedProviderUsageEvent,
  evaluateProviderRequestPlan,
  localDateKey,
  pruneProviderUsageEvents,
  summarizeDailyProviderUsage,
  upsertProviderUsageEvent,
} from '../src/services/costGuard';

function localTime(dayOffset = 0, hour = 12): number {
  return new Date(2026, 6, 11 + dayOffset, hour, 0, 0, 0).getTime();
}

function settings(overrides: Partial<CostGuardSettings> = {}): CostGuardSettings {
  return {
    enabled: true,
    maxOutputTokens: 4096,
    maxComparisonTargets: 4,
    dailyRequestLimit: 0,
    dailyCnyBudget: 0,
    dailyUsdBudget: 0,
    limitAction: 'block',
    unknownCostAction: 'warn',
    confirmPotentialMultipleCharges: true,
    ...overrides,
  };
}

function cost(
  amount: number,
  currency: CostEstimate['currency'] = 'CNY'
): CostEstimate {
  return {
    amount,
    currency,
    source: 'user-configured',
    pricingUpdatedAt: localTime(-1),
  };
}

function started(
  id: string,
  overrides: Partial<Parameters<typeof createStartedProviderUsageEvent>[0]> = {}
): ProviderUsageEvent {
  return createStartedProviderUsageEvent({
    id,
    kind: 'chat',
    providerId: 'provider-a',
    modelId: 'model-a',
    createdAt: localTime(),
    ...overrides,
  });
}

function succeeded(
  id: string,
  estimate: CostEstimate | undefined,
  overrides: Partial<Parameters<typeof createStartedProviderUsageEvent>[0]> = {}
): ProviderUsageEvent {
  return completeProviderUsageEvent(started(id, overrides), {
    status: 'succeeded',
    completedAt: (overrides.createdAt ?? localTime()) + 100,
    ...(estimate ? { knownCostEstimate: estimate } : {}),
  });
}

describe('provider usage event lifecycle', () => {
  it('creates a started event with a device-local date key and intrinsic unknown components', () => {
    const event = started('search-1', {
      kind: 'web-search',
      createdAt: localTime(),
      messageId: ' message-1 ',
      comparisonGroupId: ' compare-1 ',
      unknownCostComponents: ['provider-surcharge', 'provider-surcharge'],
    });

    expect(localDateKey(localTime())).toBe('2026-07-11');
    expect(event).toMatchObject({
      id: 'search-1',
      kind: 'web-search',
      status: 'started',
      localDateKey: '2026-07-11',
      messageId: 'message-1',
      comparisonGroupId: 'compare-1',
    });
    expect(event.unknownCostComponents).toEqual([
      'web-search-tool',
      'provider-surcharge',
    ]);
  });

  it('completes known chat cost without inventing an unknown zero', () => {
    const event = completeProviderUsageEvent(started('chat-1'), {
      status: 'succeeded',
      completedAt: localTime() + 200,
      knownCostEstimate: cost(1.25),
    });

    expect(event.status).toBe('succeeded');
    expect(event.knownCostEstimate).toEqual(cost(1.25));
    expect(event.unknownCostComponents).toEqual([]);
  });

  it('marks missing token costs and failed or cancelled outcomes as unknown', () => {
    const failed = completeProviderUsageEvent(started('failed'), {
      status: 'failed',
      completedAt: localTime() + 1,
    });
    const cancelled = completeProviderUsageEvent(started('cancelled'), {
      status: 'cancelled',
      completedAt: localTime() + 1,
      knownCostEstimate: cost(0.5),
    });

    expect(failed.knownCostEstimate).toBeUndefined();
    expect(failed.unknownCostComponents).toEqual([
      'input-tokens',
      'output-tokens',
      'failed-or-cancelled-request',
    ]);
    expect(cancelled.knownCostEstimate?.amount).toBe(0.5);
    expect(cancelled.unknownCostComponents).toContain(
      'failed-or-cancelled-request'
    );
  });

  it('upserts a completed event without mutating the original ledger', () => {
    const initial = started('same-id');
    const ledger = [initial];
    const completed = completeProviderUsageEvent(initial, {
      status: 'succeeded',
      completedAt: localTime() + 1,
      knownCostEstimate: cost(0.1),
    });

    const next = upsertProviderUsageEvent(ledger, completed);

    expect(ledger[0].status).toBe('started');
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe('succeeded');
  });

  it('rejects an attempt to complete the same event twice', () => {
    const completed = completeProviderUsageEvent(started('once'), {
      status: 'succeeded',
      completedAt: localTime() + 1,
      knownCostEstimate: cost(0.1),
    });

    expect(() =>
      completeProviderUsageEvent(completed, {
        status: 'failed',
        completedAt: localTime() + 2,
      })
    ).toThrow(/Only a started/);
  });
});

describe('provider usage retention and daily summary', () => {
  it('keeps 35 local calendar days, drops the 36th, and never drops a today-stamped event', () => {
    const today = localTime();
    const todayKey = localDateKey(today);
    const retainedBoundary = succeeded(
      'day-35',
      cost(1),
      { createdAt: localTime(-34) }
    );
    const expired = succeeded('day-36', cost(1), {
      createdAt: localTime(-35),
    });
    const todayStampedWithOldTimestamp: ProviderUsageEvent = {
      ...succeeded('today-stamped', cost(1), { createdAt: localTime(-90) }),
      localDateKey: todayKey,
    };

    const result = pruneProviderUsageEvents(
      [retainedBoundary, expired, todayStampedWithOldTimestamp],
      today
    );

    expect(result.map((event) => event.id)).toEqual([
      'day-35',
      'today-stamped',
    ]);
  });

  it('keeps CNY and USD separate and counts every unknown event once', () => {
    const events = [
      succeeded('cny', cost(2, 'CNY')),
      succeeded('usd', cost(3, 'USD')),
      succeeded('unknown', undefined),
      completeProviderUsageEvent(started('cancelled-known'), {
        status: 'cancelled',
        completedAt: localTime() + 1,
        knownCostEstimate: cost(4, 'CNY'),
      }),
      succeeded('yesterday', cost(99, 'USD'), {
        createdAt: localTime(-1),
      }),
    ];

    const result = summarizeDailyProviderUsage(events, localTime());

    expect(result).toEqual({
      localDateKey: '2026-07-11',
      requestCount: 4,
      knownCostByCurrency: { CNY: 6, USD: 3 },
      unknownEventCount: 2,
    });
  });
});

describe('evaluateProviderRequestPlan', () => {
  it('allows when disabled while still returning trustworthy local statistics', () => {
    const result = evaluateProviderRequestPlan(
      settings({ enabled: false, dailyRequestLimit: 1 }),
      [succeeded('cny', cost(2)), succeeded('usd', cost(3, 'USD')), started('unknown')],
      {
        comparison: true,
        potentialMultipleCharges: true,
        operations: [
          {
            kind: 'web-search',
            providerId: 'provider-a',
            modelId: 'model-a',
          },
          {
            kind: 'chat',
            providerId: 'provider-b',
            modelId: 'model-b',
          },
        ],
      },
      localTime()
    );

    expect(result.decision).toBe('allow');
    expect(result.independentRequestCount).toBe(2);
    expect(result.todayRequestCount).toBe(3);
    expect(result.projectedRequestCount).toBe(5);
    expect(result.todayKnownCostByCurrency).toEqual({ CNY: 2, USD: 3 });
    expect(result.todayUnknownEventCount).toBe(1);
    expect(result.reason).toContain('保险丝已关闭');
  });

  it.each([
    ['warn', 'warn'],
    ['block', 'block'],
  ] as const)('applies the %s action to the daily request limit', (limitAction, expected) => {
    const result = evaluateProviderRequestPlan(
      settings({ dailyRequestLimit: 2, limitAction }),
      [succeeded('one', cost(1)), succeeded('two', cost(1))],
      {
        operations: [
          {
            kind: 'chat',
            providerId: 'provider-a',
            modelId: 'model-a',
            projectedKnownCostEstimate: cost(0.1),
          },
        ],
      },
      localTime()
    );

    expect(result.decision).toBe(expected);
    expect(result.reason).toContain('每日 2 次');
  });

  it('evaluates CNY and USD budgets independently without conversion', () => {
    const result = evaluateProviderRequestPlan(
      settings({
        dailyCnyBudget: 10,
        dailyUsdBudget: 100,
        limitAction: 'block',
      }),
      [succeeded('cny', cost(9, 'CNY')), succeeded('usd', cost(99, 'USD'))],
      {
        operations: [
          {
            kind: 'chat',
            providerId: 'provider-a',
            modelId: 'model-a',
            projectedKnownCostEstimate: cost(2, 'CNY'),
          },
        ],
      },
      localTime()
    );

    expect(result.decision).toBe('block');
    expect(result.todayKnownCostByCurrency).toEqual({ CNY: 9, USD: 99 });
    expect(result.projectedKnownCostByCurrency).toEqual({ CNY: 11, USD: 99 });
    expect(result.reason).toContain('CNY');
    expect(result.reason).not.toContain('本次已知 USD');
  });

  it.each([
    ['warn', 'warn'],
    ['block', 'block'],
  ] as const)('never treats an unknown planned request as zero and applies %s', (unknownCostAction, expected) => {
    const result = evaluateProviderRequestPlan(
      settings({ unknownCostAction, confirmPotentialMultipleCharges: false }),
      [],
      {
        operations: [
          {
            kind: 'speech-generation',
            providerId: 'provider-a',
            modelId: 'tts-a',
          },
        ],
      },
      localTime()
    );

    expect(result.decision).toBe(expected);
    expect(result.plannedUnknownRequestCount).toBe(1);
    expect(result.reason).toContain('未知费用不会按 0');
  });

  it('requires a warning for multiple requests and search tool charges', () => {
    const result = evaluateProviderRequestPlan(
      settings({ unknownCostAction: 'warn' }),
      [],
      {
        potentialMultipleCharges: true,
        operations: [
          {
            kind: 'web-search',
            providerId: 'provider-a',
            modelId: 'model-a',
            projectedKnownCostEstimate: cost(0.5),
          },
          {
            kind: 'web-search',
            providerId: 'provider-b',
            modelId: 'model-b',
            projectedKnownCostEstimate: cost(0.5, 'USD'),
          },
        ],
      },
      localTime()
    );

    expect(result.decision).toBe('warn');
    expect(result.independentRequestCount).toBe(2);
    expect(result.plannedUnknownRequestCount).toBe(2);
    expect(result.reason).toContain('多项服务商计费');
    expect(result.reason).toContain('真实费用以服务商账单为准');
  });

  it('hard-blocks a comparison plan above the configured model count', () => {
    const operations = Array.from({ length: 3 }, (_, index) => ({
      kind: 'chat' as const,
      providerId: `provider-${index}`,
      modelId: `model-${index}`,
      projectedKnownCostEstimate: cost(0.1),
    }));
    const result = evaluateProviderRequestPlan(
      settings({
        maxComparisonTargets: 2,
        limitAction: 'warn',
        confirmPotentialMultipleCharges: false,
      }),
      [],
      { comparison: true, operations },
      localTime()
    );

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('超过已设置的 2 个模型上限');
  });

  it('throws instead of silently accepting invalid negative cost data', () => {
    expect(() =>
      evaluateProviderRequestPlan(
        settings(),
        [],
        {
          operations: [
            {
              kind: 'chat',
              providerId: 'provider-a',
              modelId: 'model-a',
              projectedKnownCostEstimate: cost(-1),
            },
          ],
        },
        localTime()
      )
    ).toThrow(/amount/);
  });
});
