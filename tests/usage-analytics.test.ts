import { describe, expect, it } from 'vitest';

import type {
  ChatConversation,
  ChatMessage,
  ModelPricing,
} from '../src/domain/types';
import {
  aggregateUsage,
  estimateMessageCost,
} from '../src/services/usageAnalytics';

function assistant(
  id: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'answer',
    createdAt: 1,
    status: 'ready',
    providerId: 'provider-a',
    providerName: 'Provider A',
    modelId: 'model-a',
    ...overrides,
  };
}

function conversation(id: string, messages: ChatMessage[]): ChatConversation {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages,
  };
}

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    providerId: 'provider-a',
    modelId: 'model-a',
    currency: 'CNY',
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 6,
    updatedAt: 10,
    ...overrides,
  };
}

describe('estimateMessageCost', () => {
  it('subtracts cached input before applying rates and never bills reasoning twice', () => {
    const message = assistant('a1', {
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 500,
        reasoningTokens: 300,
        totalTokens: 1_500,
      },
    });

    const result = estimateMessageCost(message, pricing());

    // 600 * 2 + 400 * 0.5 + 500 * 6 = 4,400 per million.
    expect(result).toEqual({
      amount: 0.0044,
      currency: 'CNY',
      source: 'user-configured',
      pricingUpdatedAt: 10,
    });
  });

  it('uses the normal input rate when no cached-input rate is configured', () => {
    const message = assistant('a1', {
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 500,
      },
    });

    const result = estimateMessageCost(
      message,
      pricing({ cachedInputPerMillion: undefined })
    );

    expect(result?.amount).toBeCloseTo(0.005, 12);
  });

  it('caps an impossible cached count at total input instead of double billing it', () => {
    const message = assistant('a1', {
      usage: {
        inputTokens: 100,
        cachedInputTokens: 140,
        outputTokens: 0,
      },
    });

    expect(estimateMessageCost(message, pricing())?.amount).toBeCloseTo(0.00005, 12);
  });

  it('returns unknown for missing usage, incomplete prices, or a mismatched target', () => {
    const message = assistant('a1', {
      usage: { inputTokens: 10, outputTokens: 5 },
      costEstimate: {
        amount: 999,
        currency: 'USD',
        source: 'user-configured',
        pricingUpdatedAt: 1,
      },
    });

    expect(estimateMessageCost(message, undefined)).toBeNull();
    expect(
      estimateMessageCost(
        { ...message, usage: { totalTokens: 15 } },
        pricing()
      )
    ).toBeNull();
    expect(
      estimateMessageCost(message, pricing({ outputPerMillion: undefined }))
    ).toBeNull();
    expect(
      estimateMessageCost(message, pricing({ modelId: 'another-model' }))
    ).toBeNull();
  });

  it.each([
    ['negative input', { inputPerMillion: -1 }],
    ['NaN cache', { cachedInputPerMillion: Number.NaN }],
    ['infinite output', { outputPerMillion: Number.POSITIVE_INFINITY }],
  ] as const)('rejects %s pricing', (_label, overrides) => {
    const message = assistant('a1', {
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    expect(() => estimateMessageCost(message, pricing(overrides))).toThrow(
      RangeError
    );
    expect(() => aggregateUsage([], [pricing(overrides)])).toThrow(RangeError);
  });
});

describe('aggregateUsage', () => {
  it('aggregates all retained request statuses by provider/model with unknown coverage', () => {
    const conversations = [
      conversation('conversation-1', [
        {
          id: 'u1',
          role: 'user',
          content: 'question',
          createdAt: 1,
          status: 'ready',
        },
        assistant('a1', {
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 50,
            reasoningTokens: 10,
            totalTokens: 150,
          },
          requestMetrics: { durationMs: 1_000, timeToFirstTokenMs: 100 },
        }),
        assistant('a2', {
          status: 'error',
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          requestMetrics: { durationMs: 500 },
        }),
        assistant('pending', {
          status: 'pending',
          usage: { inputTokens: 1_000, outputTokens: 1_000 },
        }),
        assistant('a3', {
          usage: {
            inputTokens: 200,
            outputTokens: 100,
          },
          requestMetrics: { durationMs: 1_500, timeToFirstTokenMs: 300 },
        }),
      ]),
      conversation('conversation-2', [
        assistant('b1', {
          status: 'cancelled',
          providerId: 'provider-b',
          providerName: 'Provider B',
          modelId: 'model-b',
          usage: {
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 20,
            reasoningTokens: 3,
            totalTokens: 30,
          },
          requestMetrics: { durationMs: 250, timeToFirstTokenMs: 50 },
        }),
        assistant('c1', {
          status: 'error',
          providerId: 'provider-c',
          providerName: 'Provider C',
          modelId: 'model-c',
          usage: { totalTokens: 7 },
        }),
        assistant('welcome', {
          providerId: undefined,
          modelId: undefined,
          usage: { inputTokens: 999, outputTokens: 999 },
        }),
      ]),
    ];
    const result = aggregateUsage(conversations, [
      pricing({
        inputPerMillion: 99,
        cachedInputPerMillion: 99,
        outputPerMillion: 99,
        updatedAt: 1,
      }),
      pricing({
        inputPerMillion: 1,
        cachedInputPerMillion: 0.2,
        outputPerMillion: 2,
        updatedAt: 2,
      }),
      pricing({
        providerId: 'provider-b',
        modelId: 'model-b',
        currency: 'USD',
        inputPerMillion: 3,
        cachedInputPerMillion: 1,
        outputPerMillion: 4,
        updatedAt: 1,
      }),
    ]);

    expect(result.totals).toMatchObject({
      requestCount: 5,
      readyCount: 2,
      errorCount: 2,
      cancelledCount: 1,
      inputTokens: 330,
      cachedInputTokens: 22,
      outputTokens: 175,
      reasoningTokens: 13,
      totalTokens: 512,
      durationMs: 3_250,
      durationSampleCount: 4,
      averageDurationMs: 812.5,
      timeToFirstTokenMs: 450,
      timeToFirstTokenSampleCount: 3,
      averageTimeToFirstTokenMs: 150,
      unknown: {
        inputTokens: 1,
        cachedInputTokens: 3,
        outputTokens: 1,
        reasoningTokens: 3,
        totalTokens: 0,
        durationMs: 1,
        timeToFirstTokenMs: 2,
        pricing: 1,
        cost: 1,
      },
    });
    expect(result.totals.costByCurrency.CNY).toBeCloseTo(0.000614, 12);
    expect(result.totals.costByCurrency.USD).toBeCloseTo(0.000106, 12);
    expect(result.totals.costSampleCountByCurrency).toEqual({ CNY: 3, USD: 1 });

    expect(result.byProviderModel).toHaveLength(3);
    expect(result.byProviderModel[0]).toMatchObject({
      providerId: 'provider-a',
      providerName: 'Provider A',
      modelId: 'model-a',
      requestCount: 3,
      readyCount: 2,
      errorCount: 1,
      cancelledCount: 0,
      inputTokens: 320,
      outputTokens: 155,
      totalTokens: 475,
      durationMs: 3_000,
      averageDurationMs: 1_000,
    });
    expect(result.byProviderModel[0].costByCurrency).toEqual({
      CNY: expect.any(Number),
      USD: 0,
    });
    expect(result.byProviderModel[0].costSampleCountByCurrency).toEqual({ CNY: 3, USD: 0 });
    expect(result.byProviderModel[1]).toMatchObject({
      providerId: 'provider-b',
      modelId: 'model-b',
      requestCount: 1,
    });
    expect(result.byProviderModel[2]).toMatchObject({
      providerId: 'provider-c',
      modelId: 'model-c',
      requestCount: 1,
      unknown: { pricing: 1, cost: 1 },
    });
  });

  it('counts legacy assistant requests in an explicit unknown provider/model group', () => {
    const result = aggregateUsage([
      conversation('legacy', [
        assistant('legacy-answer', {
          providerId: undefined,
          providerName: undefined,
          modelId: undefined,
          usage: { inputTokens: 2, outputTokens: 3 },
        }),
      ]),
    ]);

    expect(result.totals.requestCount).toBe(1);
    expect(result.byProviderModel).toEqual([
      expect.objectContaining({
        providerId: 'unknown-provider',
        modelId: 'unknown-model',
        requestCount: 1,
        totalTokens: 5,
        unknown: expect.objectContaining({ pricing: 1, cost: 1 }),
      }),
    ]);
  });

  it('marks incomplete user pricing as unknown rather than trusting message snapshots', () => {
    const message = assistant('a1', {
      usage: { inputTokens: 10, outputTokens: 5 },
      costEstimate: {
        amount: 123,
        currency: 'USD',
        source: 'user-configured',
        pricingUpdatedAt: 1,
      },
    });
    const result = aggregateUsage(
      [conversation('c1', [message])],
      [pricing({ outputPerMillion: undefined })]
    );

    expect(result.totals.costByCurrency).toEqual({ CNY: 0, USD: 0 });
    expect(result.totals.unknown.pricing).toBe(1);
    expect(result.totals.unknown.cost).toBe(1);
  });
});
