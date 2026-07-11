import type {
  ChatConversation,
  ChatMessage,
  CostEstimate,
  ModelPricing,
  PricingCurrency,
} from '../domain/types';
import { canonicalMessageId } from './conversationBranches';

const currencies: readonly PricingCurrency[] = ['CNY', 'USD'];
const includedStatuses = new Set<ChatMessage['status']>(['ready', 'error', 'cancelled']);
const unknownProviderId = 'unknown-provider';
const unknownModelId = 'unknown-model';

export interface UsageUnknownCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  timeToFirstTokenMs: number;
  pricing: number;
  cost: number;
}

export interface UsageSummary {
  requestCount: number;
  readyCount: number;
  errorCount: number;
  cancelledCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  durationSampleCount: number;
  averageDurationMs?: number;
  timeToFirstTokenMs: number;
  timeToFirstTokenSampleCount: number;
  averageTimeToFirstTokenMs?: number;
  costByCurrency: Record<PricingCurrency, number>;
  costSampleCountByCurrency: Record<PricingCurrency, number>;
  unknown: UsageUnknownCounts;
}

export interface ProviderModelUsageSummary extends UsageSummary {
  providerId: string;
  providerName?: string;
  modelId: string;
}

export interface UsageAggregation {
  totals: UsageSummary;
  byProviderModel: ProviderModelUsageSummary[];
}

type MutableUsageSummary = Omit<
  UsageSummary,
  'averageDurationMs' | 'averageTimeToFirstTokenMs'
>;

function emptyUnknownCounts(): UsageUnknownCounts {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    timeToFirstTokenMs: 0,
    pricing: 0,
    cost: 0,
  };
}

function emptySummary(): MutableUsageSummary {
  return {
    requestCount: 0,
    readyCount: 0,
    errorCount: 0,
    cancelledCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    durationSampleCount: 0,
    timeToFirstTokenMs: 0,
    timeToFirstTokenSampleCount: 0,
    costByCurrency: { CNY: 0, USD: 0 },
    costSampleCountByCurrency: { CNY: 0, USD: 0 },
    unknown: emptyUnknownCounts(),
  };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertOptionalPrice(value: number | undefined, label: string): void {
  if (value !== undefined && !finiteNonNegative(value)) {
    throw new RangeError(`${label} must be a finite, non-negative number.`);
  }
}

function assertPricing(pricing: ModelPricing): void {
  if (!currencies.includes(pricing.currency)) {
    throw new RangeError(`Unsupported pricing currency: ${String(pricing.currency)}.`);
  }
  if (!finiteNonNegative(pricing.updatedAt)) {
    throw new RangeError('Pricing updatedAt must be a finite, non-negative number.');
  }
  assertOptionalPrice(pricing.inputPerMillion, 'inputPerMillion');
  assertOptionalPrice(pricing.cachedInputPerMillion, 'cachedInputPerMillion');
  assertOptionalPrice(pricing.outputPerMillion, 'outputPerMillion');
}

function normalizedToken(value: unknown): number | undefined {
  return finiteNonNegative(value) ? value : undefined;
}

function pricingMatchesMessage(message: ChatMessage, pricing: ModelPricing): boolean {
  return message.providerId === pricing.providerId && message.modelId === pricing.modelId;
}

/**
 * Estimates one request using only the caller-supplied, user-configured price.
 * Reasoning tokens are intentionally not billed again because providers report
 * them as a detail of output tokens. A missing cached-token detail is treated as
 * zero, so the full input is conservatively billed at the normal input rate.
 */
export function estimateMessageCost(
  message: ChatMessage,
  pricing: ModelPricing | null | undefined
): CostEstimate | null {
  if (!pricing) {
    return null;
  }
  assertPricing(pricing);

  if (!pricingMatchesMessage(message, pricing)) {
    return null;
  }

  const inputTokens = normalizedToken(message.usage?.inputTokens);
  const outputTokens = normalizedToken(message.usage?.outputTokens);
  const cachedValue = message.usage?.cachedInputTokens;
  const cachedInputTokens = cachedValue === undefined ? 0 : normalizedToken(cachedValue);

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedInputTokens === undefined ||
    pricing.inputPerMillion === undefined ||
    pricing.outputPerMillion === undefined
  ) {
    return null;
  }

  const billableCachedInputTokens = Math.min(inputTokens, cachedInputTokens);
  const uncachedInputTokens = inputTokens - billableCachedInputTokens;
  const cachedInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const amount =
    (uncachedInputTokens * pricing.inputPerMillion +
      billableCachedInputTokens * cachedInputRate +
      outputTokens * pricing.outputPerMillion) /
    1_000_000;

  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError('Calculated cost must be a finite, non-negative number.');
  }

  return {
    amount,
    currency: pricing.currency,
    source: 'user-configured',
    pricingUpdatedAt: pricing.updatedAt,
  };
}

function pricingKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function buildPricingIndex(pricing: readonly ModelPricing[]): Map<string, ModelPricing> {
  const index = new Map<string, ModelPricing>();
  for (const entry of pricing) {
    assertPricing(entry);
    const key = pricingKey(entry.providerId, entry.modelId);
    const current = index.get(key);
    if (!current || entry.updatedAt >= current.updatedAt) {
      index.set(key, entry);
    }
  }
  return index;
}

function addOptionalValue(
  summary: MutableUsageSummary,
  field: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens',
  value: unknown
): number | undefined {
  const normalized = normalizedToken(value);
  if (normalized === undefined) {
    summary.unknown[field] += 1;
    return undefined;
  }
  summary[field] += normalized;
  return normalized;
}

function addMetrics(summary: MutableUsageSummary, message: ChatMessage): void {
  const durationMs = normalizedToken(message.requestMetrics?.durationMs);
  if (durationMs === undefined) {
    summary.unknown.durationMs += 1;
  } else {
    summary.durationMs += durationMs;
    summary.durationSampleCount += 1;
  }

  const timeToFirstTokenMs = normalizedToken(message.requestMetrics?.timeToFirstTokenMs);
  if (timeToFirstTokenMs === undefined) {
    summary.unknown.timeToFirstTokenMs += 1;
  } else {
    summary.timeToFirstTokenMs += timeToFirstTokenMs;
    summary.timeToFirstTokenSampleCount += 1;
  }
}

function addMessage(
  summary: MutableUsageSummary,
  message: ChatMessage,
  pricing: ModelPricing | undefined
): void {
  summary.requestCount += 1;
  if (message.status === 'ready') summary.readyCount += 1;
  if (message.status === 'error') summary.errorCount += 1;
  if (message.status === 'cancelled') summary.cancelledCount += 1;

  const inputTokens = addOptionalValue(summary, 'inputTokens', message.usage?.inputTokens);
  const outputTokens = addOptionalValue(summary, 'outputTokens', message.usage?.outputTokens);
  addOptionalValue(summary, 'cachedInputTokens', message.usage?.cachedInputTokens);
  addOptionalValue(summary, 'reasoningTokens', message.usage?.reasoningTokens);

  const explicitTotal = normalizedToken(message.usage?.totalTokens);
  if (explicitTotal !== undefined) {
    summary.totalTokens += explicitTotal;
  } else if (
    message.usage?.totalTokens === undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined
  ) {
    // Output already includes reasoning tokens; do not add reasoning again.
    summary.totalTokens += inputTokens + outputTokens;
  } else {
    summary.unknown.totalTokens += 1;
  }

  addMetrics(summary, message);

  const completePricing = Boolean(
    pricing &&
      pricing.inputPerMillion !== undefined &&
      pricing.outputPerMillion !== undefined
  );
  if (!completePricing) {
    summary.unknown.pricing += 1;
  }

  const cost = estimateMessageCost(message, pricing);
  if (!cost) {
    summary.unknown.cost += 1;
  } else {
    summary.costByCurrency[cost.currency] += cost.amount;
    summary.costSampleCountByCurrency[cost.currency] += 1;
  }
}

function finalizeSummary(summary: MutableUsageSummary): UsageSummary {
  return {
    ...summary,
    costByCurrency: { ...summary.costByCurrency },
    costSampleCountByCurrency: { ...summary.costSampleCountByCurrency },
    unknown: { ...summary.unknown },
    ...(summary.durationSampleCount
      ? { averageDurationMs: summary.durationMs / summary.durationSampleCount }
      : {}),
    ...(summary.timeToFirstTokenSampleCount
      ? {
          averageTimeToFirstTokenMs:
            summary.timeToFirstTokenMs / summary.timeToFirstTokenSampleCount,
        }
      : {}),
  };
}

function isIncludedAssistantRequest(message: ChatMessage): boolean {
  return (
    message.id !== 'welcome' &&
    message.role === 'assistant' &&
    includedStatuses.has(message.status)
  );
}

function messageOccurrenceKey(conversationId: string, messageIndex: number): string {
  return JSON.stringify([conversationId, messageIndex]);
}

function findBranchSourceOccurrence(
  conversationsById: ReadonlyMap<string, ChatConversation>,
  conversation: ChatConversation,
  message: ChatMessage
): string | undefined {
  const canonicalId = canonicalMessageId(message);
  const visited = new Set<string>([conversation.id]);
  let parentId = conversation.parentConversationId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = conversationsById.get(parentId);
    if (!parent) {
      return undefined;
    }
    const sourceIndex = parent.messages.findIndex(
      (candidate) =>
        !candidate.originMessageId &&
        candidate.id === canonicalId &&
        candidate.role === message.role
    );
    if (sourceIndex >= 0) {
      return messageOccurrenceKey(parent.id, sourceIndex);
    }
    parentId = parent.parentConversationId;
  }
  return undefined;
}

/**
 * Builds occurrence-aware keys for inherited branch messages. Raw message IDs
 * are not globally unique in legacy data, so only an explicit origin link can
 * join messages across conversations. A valid ancestor source is joined to its
 * clones; unrelated messages that happen to reuse the same ID remain separate.
 */
function buildBranchDeduplicationKeys(
  conversations: readonly ChatConversation[]
): ReadonlyMap<string, string> {
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation] as const)
  );
  const keys = new Map<string, string>();

  for (const conversation of conversations) {
    conversation.messages.forEach((message, messageIndex) => {
      if (!message.originMessageId) {
        return;
      }
      const occurrence = messageOccurrenceKey(conversation.id, messageIndex);
      const sourceOccurrence = findBranchSourceOccurrence(
        conversationsById,
        conversation,
        message
      );
      const groupKey = sourceOccurrence
        ? `source:${sourceOccurrence}`
        : `orphan:${message.role}:${canonicalMessageId(message)}`;
      keys.set(occurrence, groupKey);
      if (sourceOccurrence) {
        keys.set(sourceOccurrence, groupKey);
      }
    });
  }

  return keys;
}

/** Aggregates retained assistant requests across every supplied conversation. */
export function aggregateUsage(
  conversations: readonly ChatConversation[],
  pricing: readonly ModelPricing[] = []
): UsageAggregation {
  const pricingIndex = buildPricingIndex(pricing);
  const totals = emptySummary();
  const groups = new Map<
    string,
    {
      providerId: string;
      providerName?: string;
      modelId: string;
      summary: MutableUsageSummary;
    }
  >();
  const seenRequestKeys = new Set<string>();
  const branchDeduplicationKeys = buildBranchDeduplicationKeys(conversations);
  const messageOccurrences = conversations.flatMap((conversation) =>
    conversation.messages.map((message, messageIndex) => ({
      conversation,
      message,
      messageIndex,
    }))
  );
  // Prefer the original source when both it and an inherited clone are present.
  messageOccurrences.sort(
    (left, right) =>
      Number(Boolean(left.message.originMessageId)) -
      Number(Boolean(right.message.originMessageId))
  );

  for (const { conversation, message, messageIndex } of messageOccurrences) {
    if (!isIncludedAssistantRequest(message)) {
      continue;
    }
    const occurrence = messageOccurrenceKey(conversation.id, messageIndex);
    const canonicalId = branchDeduplicationKeys.get(occurrence) ?? `message:${occurrence}`;
    if (seenRequestKeys.has(canonicalId)) {
      continue;
    }
    seenRequestKeys.add(canonicalId);

    const providerId = message.providerId?.trim() || unknownProviderId;
    const modelId = message.modelId?.trim() || unknownModelId;
    const key = pricingKey(providerId, modelId);
    const modelPricing = pricingIndex.get(key);
    let group = groups.get(key);
    if (!group) {
      group = {
        providerId,
        ...(message.providerName?.trim() ? { providerName: message.providerName.trim() } : {}),
        modelId,
        summary: emptySummary(),
      };
      groups.set(key, group);
    } else if (!group.providerName && message.providerName?.trim()) {
      group.providerName = message.providerName.trim();
    }

    addMessage(totals, message, modelPricing);
    addMessage(group.summary, message, modelPricing);
  }

  const byProviderModel = [...groups.values()]
    .map((group): ProviderModelUsageSummary => ({
      providerId: group.providerId,
      ...(group.providerName ? { providerName: group.providerName } : {}),
      modelId: group.modelId,
      ...finalizeSummary(group.summary),
    }))
    .sort(
      (left, right) =>
        right.requestCount - left.requestCount ||
        left.providerId.localeCompare(right.providerId) ||
        left.modelId.localeCompare(right.modelId)
    );

  return {
    totals: finalizeSummary(totals),
    byProviderModel,
  };
}
