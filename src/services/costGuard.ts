import type {
  CostEstimate,
  CostGuardSettings,
  PricingCurrency,
  ProviderUsageEvent,
  ProviderUsageKind,
  ProviderUsageStatus,
  UnknownCostComponent,
} from '../domain/types';

export const COST_GUARD_RETENTION_DAYS = 35;

const currencies: readonly PricingCurrency[] = ['CNY', 'USD'];
const comparisonTargetCounts = new Set<CostGuardSettings['maxComparisonTargets']>([2, 3, 4]);
const providerUsageKinds = new Set<ProviderUsageKind>([
  'chat',
  'web-search',
  'image-generation',
  'video-generation',
  'audio-transcription',
  'speech-generation',
]);
const terminalStatuses = new Set<Exclude<ProviderUsageStatus, 'started'>>([
  'succeeded',
  'failed',
  'cancelled',
]);
const unknownCostComponents = new Set<UnknownCostComponent>([
  'input-tokens',
  'output-tokens',
  'web-search-tool',
  'speech',
  'transcription',
  'image-output',
  'video-output',
  'provider-surcharge',
  'failed-or-cancelled-request',
]);
const localDateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateStartedProviderUsageEventArgs {
  id: string;
  kind: ProviderUsageKind;
  providerId: string;
  modelId: string;
  createdAt: number;
  messageId?: string;
  comparisonGroupId?: string;
  unknownCostComponents?: readonly UnknownCostComponent[];
}

export interface CompleteProviderUsageEventArgs {
  status: Exclude<ProviderUsageStatus, 'started'>;
  completedAt: number;
  knownCostEstimate?: CostEstimate;
  unknownCostComponents?: readonly UnknownCostComponent[];
}

export interface ProviderRequestOperation {
  kind: ProviderUsageKind;
  providerId: string;
  modelId: string;
  projectedKnownCostEstimate?: CostEstimate;
  unknownCostComponents?: readonly UnknownCostComponent[];
}

export interface ProviderRequestPlan {
  operations: readonly ProviderRequestOperation[];
  comparison?: boolean;
  potentialMultipleCharges?: boolean;
}

export type CostGuardDecision = 'allow' | 'warn' | 'block';

export interface DailyProviderUsageSummary {
  localDateKey: string;
  requestCount: number;
  knownCostByCurrency: Record<PricingCurrency, number>;
  unknownEventCount: number;
}

export interface ProviderRequestPlanEvaluation {
  decision: CostGuardDecision;
  reason: string;
  reasons: string[];
  independentRequestCount: number;
  todayRequestCount: number;
  projectedRequestCount: number;
  todayKnownCostByCurrency: Record<PricingCurrency, number>;
  projectedKnownCostByCurrency: Record<PricingCurrency, number>;
  todayUnknownEventCount: number;
  plannedUnknownRequestCount: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!finiteNonNegative(value)) {
    throw new RangeError(`${label} must be a finite, non-negative timestamp.`);
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RangeError(`${label} must not be empty.`);
  }
  return normalized;
}

function assertCostEstimate(value: CostEstimate, label: string): void {
  if (!finiteNonNegative(value.amount)) {
    throw new RangeError(`${label}.amount must be finite and non-negative.`);
  }
  if (!currencies.includes(value.currency)) {
    throw new RangeError(`${label}.currency is unsupported.`);
  }
  if (value.source !== 'user-configured') {
    throw new RangeError(`${label}.source is unsupported.`);
  }
  assertTimestamp(value.pricingUpdatedAt, `${label}.pricingUpdatedAt`);
}

function uniqueUnknownComponents(
  values: readonly UnknownCostComponent[]
): UnknownCostComponent[] {
  const result: UnknownCostComponent[] = [];
  const seen = new Set<UnknownCostComponent>();
  for (const value of values) {
    if (!unknownCostComponents.has(value)) {
      throw new RangeError(`Unsupported unknown cost component: ${String(value)}.`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function intrinsicUnknownComponents(kind: ProviderUsageKind): UnknownCostComponent[] {
  if (kind === 'web-search') return ['web-search-tool'];
  if (kind === 'image-generation') return ['image-output'];
  if (kind === 'video-generation') return ['video-output'];
  if (kind === 'audio-transcription') return ['transcription'];
  if (kind === 'speech-generation') return ['speech'];
  return [];
}

function missingTokenCostComponents(kind: ProviderUsageKind): UnknownCostComponent[] {
  return kind === 'chat' || kind === 'web-search'
    ? ['input-tokens', 'output-tokens']
    : [];
}

function assertUsageKind(kind: ProviderUsageKind): void {
  if (!providerUsageKinds.has(kind)) {
    throw new RangeError(`Unsupported provider usage kind: ${String(kind)}.`);
  }
}

function assertLocalDateKey(value: string): void {
  if (!localDateKeyPattern.test(value)) {
    throw new RangeError(`Invalid local date key: ${value}.`);
  }
}

function assertUsageEvent(event: ProviderUsageEvent, label = 'event'): void {
  nonEmpty(event.id, `${label}.id`);
  nonEmpty(event.providerId, `${label}.providerId`);
  nonEmpty(event.modelId, `${label}.modelId`);
  assertUsageKind(event.kind);
  assertTimestamp(event.createdAt, `${label}.createdAt`);
  assertLocalDateKey(event.localDateKey);
  if (event.completedAt !== undefined) {
    assertTimestamp(event.completedAt, `${label}.completedAt`);
  }
  if (event.knownCostEstimate) {
    assertCostEstimate(event.knownCostEstimate, `${label}.knownCostEstimate`);
  }
  uniqueUnknownComponents(event.unknownCostComponents);
}

function assertSettings(settings: CostGuardSettings): void {
  if (!Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens <= 0) {
    throw new RangeError('maxOutputTokens must be a positive safe integer.');
  }
  if (!comparisonTargetCounts.has(settings.maxComparisonTargets)) {
    throw new RangeError('maxComparisonTargets must be 2, 3, or 4.');
  }
  if (!Number.isSafeInteger(settings.dailyRequestLimit) || settings.dailyRequestLimit < 0) {
    throw new RangeError('dailyRequestLimit must be a non-negative safe integer.');
  }
  if (!finiteNonNegative(settings.dailyCnyBudget) || !finiteNonNegative(settings.dailyUsdBudget)) {
    throw new RangeError('Daily budgets must be finite and non-negative.');
  }
  if (settings.limitAction !== 'warn' && settings.limitAction !== 'block') {
    throw new RangeError('limitAction must be warn or block.');
  }
  if (settings.unknownCostAction !== 'warn' && settings.unknownCostAction !== 'block') {
    throw new RangeError('unknownCostAction must be warn or block.');
  }
}

function cloneCostEstimate(value: CostEstimate | undefined): CostEstimate | undefined {
  return value ? { ...value } : undefined;
}

function emptyCostTotals(): Record<PricingCurrency, number> {
  return { CNY: 0, USD: 0 };
}

function formatKnownAmount(currency: PricingCurrency, amount: number): string {
  return `${currency} ${amount.toFixed(6)}`;
}

function eventHasUnknownCost(event: ProviderUsageEvent): boolean {
  return (
    event.status !== 'succeeded' ||
    !event.knownCostEstimate ||
    event.unknownCostComponents.length > 0
  );
}

function operationUnknownComponents(
  operation: ProviderRequestOperation
): UnknownCostComponent[] {
  return uniqueUnknownComponents([
    ...intrinsicUnknownComponents(operation.kind),
    ...(operation.projectedKnownCostEstimate
      ? []
      : missingTokenCostComponents(operation.kind)),
    ...(operation.unknownCostComponents ?? []),
  ]);
}

/** Returns YYYY-MM-DD in the device's local timezone. */
export function localDateKey(timestamp: number): string {
  assertTimestamp(timestamp, 'timestamp');
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('timestamp is outside the supported Date range.');
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Creates one immutable local request-attempt event before any provider call starts. */
export function createStartedProviderUsageEvent({
  id,
  kind,
  providerId,
  modelId,
  createdAt,
  messageId,
  comparisonGroupId,
  unknownCostComponents: additionalUnknownComponents = [],
}: CreateStartedProviderUsageEventArgs): ProviderUsageEvent {
  assertUsageKind(kind);
  assertTimestamp(createdAt, 'createdAt');
  return {
    id: nonEmpty(id, 'id'),
    kind,
    status: 'started',
    providerId: nonEmpty(providerId, 'providerId'),
    modelId: nonEmpty(modelId, 'modelId'),
    createdAt,
    localDateKey: localDateKey(createdAt),
    ...(messageId?.trim() ? { messageId: messageId.trim() } : {}),
    ...(comparisonGroupId?.trim()
      ? { comparisonGroupId: comparisonGroupId.trim() }
      : {}),
    unknownCostComponents: uniqueUnknownComponents([
      ...intrinsicUnknownComponents(kind),
      ...additionalUnknownComponents,
    ]),
  };
}

/** Completes a started event without ever converting missing or partial cost data to zero. */
export function completeProviderUsageEvent(
  event: ProviderUsageEvent,
  {
    status,
    completedAt,
    knownCostEstimate,
    unknownCostComponents: additionalUnknownComponents = [],
  }: CompleteProviderUsageEventArgs
): ProviderUsageEvent {
  assertUsageEvent(event);
  if (event.status !== 'started') {
    throw new RangeError('Only a started provider usage event can be completed.');
  }
  if (!terminalStatuses.has(status)) {
    throw new RangeError('Completion status must be succeeded, failed, or cancelled.');
  }
  assertTimestamp(completedAt, 'completedAt');
  if (completedAt < event.createdAt) {
    throw new RangeError('completedAt must not be earlier than createdAt.');
  }
  if (knownCostEstimate) {
    assertCostEstimate(knownCostEstimate, 'knownCostEstimate');
  }

  const failureComponents: UnknownCostComponent[] =
    status === 'failed' || status === 'cancelled'
      ? ['failed-or-cancelled-request']
      : [];
  const missingCostComponents = knownCostEstimate
    ? []
    : missingTokenCostComponents(event.kind);

  return {
    ...event,
    status,
    completedAt,
    ...(knownCostEstimate
      ? { knownCostEstimate: cloneCostEstimate(knownCostEstimate) }
      : {}),
    unknownCostComponents: uniqueUnknownComponents([
      ...event.unknownCostComponents,
      ...missingCostComponents,
      ...additionalUnknownComponents,
      ...failureComponents,
    ]),
  };
}

/** Replaces an event with the same ID, or appends it when it is new. */
export function upsertProviderUsageEvent(
  events: readonly ProviderUsageEvent[],
  event: ProviderUsageEvent
): ProviderUsageEvent[] {
  assertUsageEvent(event);
  const index = events.findIndex((candidate) => candidate.id === event.id);
  if (index < 0) {
    return [...events, event];
  }
  return events.map((candidate, candidateIndex) =>
    candidateIndex === index ? event : candidate
  );
}

/** Keeps 35 local calendar days by default and never removes an event stamped as today. */
export function pruneProviderUsageEvents(
  events: readonly ProviderUsageEvent[],
  now: number,
  retentionDays = COST_GUARD_RETENTION_DAYS
): ProviderUsageEvent[] {
  assertTimestamp(now, 'now');
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new RangeError('retentionDays must be a positive safe integer.');
  }
  const today = localDateKey(now);
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
  const cutoffKey = localDateKey(cutoff.getTime());

  return events.filter((event, index) => {
    assertUsageEvent(event, `events[${index}]`);
    return event.localDateKey === today || event.localDateKey >= cutoffKey;
  });
}

/** Summarizes immutable local estimates without currency conversion. */
export function summarizeDailyProviderUsage(
  events: readonly ProviderUsageEvent[],
  now: number
): DailyProviderUsageSummary {
  const today = localDateKey(now);
  const knownCostByCurrency = emptyCostTotals();
  let requestCount = 0;
  let unknownEventCount = 0;

  events.forEach((event, index) => {
    assertUsageEvent(event, `events[${index}]`);
    if (event.localDateKey !== today) {
      return;
    }
    requestCount += 1;
    if (event.knownCostEstimate) {
      knownCostByCurrency[event.knownCostEstimate.currency] +=
        event.knownCostEstimate.amount;
    }
    if (eventHasUnknownCost(event)) {
      unknownEventCount += 1;
    }
  });

  return {
    localDateKey: today,
    requestCount,
    knownCostByCurrency,
    unknownEventCount,
  };
}

/**
 * Evaluates only local request attempts and caller-supplied estimates. It never
 * treats an unknown component as zero and never represents a provider bill.
 */
export function evaluateProviderRequestPlan(
  settings: CostGuardSettings,
  events: readonly ProviderUsageEvent[],
  plan: ProviderRequestPlan,
  now: number
): ProviderRequestPlanEvaluation {
  assertSettings(settings);
  const today = summarizeDailyProviderUsage(events, now);
  const operations = [...plan.operations];
  operations.forEach((operation, index) => {
    assertUsageKind(operation.kind);
    nonEmpty(operation.providerId, `operations[${index}].providerId`);
    nonEmpty(operation.modelId, `operations[${index}].modelId`);
    if (operation.projectedKnownCostEstimate) {
      assertCostEstimate(
        operation.projectedKnownCostEstimate,
        `operations[${index}].projectedKnownCostEstimate`
      );
    }
    operationUnknownComponents(operation);
  });

  const independentRequestCount = operations.length;
  const projectedRequestCount = today.requestCount + independentRequestCount;
  const projectedKnownCostByCurrency = { ...today.knownCostByCurrency };
  let plannedUnknownRequestCount = 0;

  for (const operation of operations) {
    if (operation.projectedKnownCostEstimate) {
      projectedKnownCostByCurrency[operation.projectedKnownCostEstimate.currency] +=
        operation.projectedKnownCostEstimate.amount;
    }
    if (
      !operation.projectedKnownCostEstimate ||
      operationUnknownComponents(operation).length > 0
    ) {
      plannedUnknownRequestCount += 1;
    }
  }

  const reasons: string[] = [];
  let decision: CostGuardDecision = 'allow';
  const raiseDecision = (candidate: Exclude<CostGuardDecision, 'allow'>) => {
    if (candidate === 'block' || decision === 'allow') {
      decision = candidate;
    }
  };

  if (!settings.enabled) {
    reasons.push('费用保险丝已关闭；以下仅为本机事件统计，不代表服务商账单。');
  } else {
    if (
      plan.comparison &&
      independentRequestCount > settings.maxComparisonTargets
    ) {
      decision = 'block';
      reasons.push(
        `本次对比包含 ${independentRequestCount} 个模型，超过已设置的 ${settings.maxComparisonTargets} 个模型上限。`
      );
    }

    const requestLimitReached =
      settings.dailyRequestLimit > 0 &&
      independentRequestCount > 0 &&
      (today.requestCount >= settings.dailyRequestLimit ||
        projectedRequestCount > settings.dailyRequestLimit);
    if (requestLimitReached) {
      raiseDecision(settings.limitAction);
      reasons.push(
        `本次包含 ${independentRequestCount} 次独立服务商请求，今日将从 ${today.requestCount} 次增至 ${projectedRequestCount} 次，超过或已达到每日 ${settings.dailyRequestLimit} 次的本机限制。`
      );
    }

    const budgetLimits: Record<PricingCurrency, number> = {
      CNY: settings.dailyCnyBudget,
      USD: settings.dailyUsdBudget,
    };
    for (const currency of currencies) {
      const limit = budgetLimits[currency];
      const current = today.knownCostByCurrency[currency];
      const projected = projectedKnownCostByCurrency[currency];
      const reached =
        limit > 0 &&
        independentRequestCount > 0 &&
        (current >= limit || projected > limit);
      if (reached) {
        raiseDecision(settings.limitAction);
        reasons.push(
          `本次已知 ${currency} 估算会使今日小计从 ${formatKnownAmount(currency, current)} 变为 ${formatKnownAmount(currency, projected)}，超过或已达到本机预算 ${formatKnownAmount(currency, limit)}。`
        );
      }
    }

    if (plannedUnknownRequestCount > 0) {
      raiseDecision(settings.unknownCostAction);
      reasons.push(
        `本次有 ${plannedUnknownRequestCount} 个请求包含本机无法确认的费用；未知费用不会按 0 计算，真实费用以服务商账单为准。`
      );
    }

    const potentialMultipleCharges =
      plan.potentialMultipleCharges === true ||
      independentRequestCount > 1 ||
      operations.some((operation) => operation.kind === 'web-search');
    if (
      settings.confirmPotentialMultipleCharges &&
      potentialMultipleCharges &&
      independentRequestCount > 0
    ) {
      raiseDecision('warn');
      reasons.push(
        `本次可能产生 ${independentRequestCount} 次独立请求或联网工具等多项服务商计费，需要用户确认。`
      );
    }

    if (!reasons.length) {
      reasons.push('未触发已启用的本机次数、已知费用或未知费用限制。');
    }
  }

  return {
    decision,
    reason: reasons.join('\n'),
    reasons,
    independentRequestCount,
    todayRequestCount: today.requestCount,
    projectedRequestCount,
    todayKnownCostByCurrency: { ...today.knownCostByCurrency },
    projectedKnownCostByCurrency,
    todayUnknownEventCount: today.unknownEventCount,
    plannedUnknownRequestCount,
  };
}
