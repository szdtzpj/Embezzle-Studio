import type {
  AppWorkspace,
  ChatMessage,
  ProviderUsageEvent,
} from '../../../../domain/types';
import {
  completeProviderUsageEvent,
  createStartedProviderUsageEvent,
  evaluateProviderRequestPlan,
  pruneProviderUsageEvents,
  upsertProviderUsageEvent,
  type ProviderRequestPlan,
} from '../../../../services/costGuard';

export interface ChatUsageLedgerHost {
  readWorkspace(): AppWorkspace;
  isReplacing(): boolean;
  replaceUsageEvents(events: ProviderUsageEvent[]): Promise<boolean>;
  flushRequired(): Promise<void>;
  confirmCost(reason: string): Promise<boolean>;
  notify(message: string): void;
  now(): number;
}

/**
 * Owns Chat request authorization and the durable local attempt ledger. The
 * interface keeps callers from duplicating warning/replacement revalidation,
 * insertion rollback, pruning, and unknown-cost completion semantics.
 */
export class ChatUsageLedger {
  constructor(private readonly host: ChatUsageLedgerHost) {}

  async authorize(plan: ProviderRequestPlan): Promise<boolean> {
    if (this.host.isReplacing()) {
      this.host.notify('正在验证并导入备份，暂时不能发起新请求。');
      return false;
    }

    const current = this.host.readWorkspace();
    const evaluation = evaluateProviderRequestPlan(
      current.costGuard,
      current.providerUsageEvents,
      plan,
      this.host.now()
    );
    if (evaluation.decision === 'block') {
      this.host.notify(`请求未发出：${evaluation.reason}`);
      return false;
    }
    if (evaluation.decision === 'warn') {
      const confirmed = await this.host.confirmCost(evaluation.reason);
      if (this.host.isReplacing()) {
        this.host.notify('备份导入已开始，本次请求未发出。');
        return false;
      }
      return confirmed;
    }
    return !this.host.isReplacing();
  }

  createStarted(
    input: Parameters<typeof createStartedProviderUsageEvent>[0]
  ): ProviderUsageEvent {
    return createStartedProviderUsageEvent(input);
  }

  async persist(events: readonly ProviderUsageEvent[]): Promise<void> {
    const current = this.host.readWorkspace();
    const insertedEventIds = new Set(
      events
        .filter(
          (event) => !current.providerUsageEvents.some((existing) => existing.id === event.id)
        )
        .map((event) => event.id)
    );
    const nextEvents = pruneProviderUsageEvents(
      events.reduce(
        (result, event) => upsertProviderUsageEvent(result, event),
        current.providerUsageEvents
      ),
      this.host.now()
    );

    const accepted = await this.host.replaceUsageEvents(nextEvents);
    if (!accepted) {
      throw new Error('工作区当前不可写，请求未发出。');
    }

    try {
      await this.host.flushRequired();
    } catch (error) {
      if (current.costGuard.enabled) {
        if (insertedEventIds.size) {
          const rollbackEvents = this.host
            .readWorkspace()
            .providerUsageEvents.filter((event) => !insertedEventIds.has(event.id));
          await this.host.replaceUsageEvents(rollbackEvents);
          try {
            await this.host.flushRequired();
          } catch {
            // The in-memory rollback remains authoritative and the request stays blocked.
          }
        }
        throw new Error(
          `费用保险丝台账无法安全写入，请求未发出：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      this.host.notify('本机请求台账暂时无法持久化；费用保险丝关闭状态下仍继续本次请求。');
    }
  }

  /**
   * Removes started attempts that were committed before the visible request
   * messages. A rejected append must not leave a phantom billable attempt in
   * the local ledger. Only matching events that are still `started` are
   * removed, so a concurrent terminal update cannot be erased accidentally.
   */
  async rollbackStarted(events: readonly ProviderUsageEvent[]): Promise<void> {
    const ids = new Set(
      events.filter((event) => event.status === 'started').map((event) => event.id)
    );
    if (!ids.size) return;

    const current = this.host.readWorkspace();
    const rollbackEvents = current.providerUsageEvents.filter(
      (event) => !(ids.has(event.id) && event.status === 'started')
    );
    if (rollbackEvents.length === current.providerUsageEvents.length) return;

    const accepted = await this.host.replaceUsageEvents(rollbackEvents);
    if (!accepted) {
      throw new Error('工作区当前不可写，已发起请求的台账回滚失败。');
    }

    try {
      await this.host.flushRequired();
    } catch (error) {
      if (current.costGuard.enabled) {
        throw new Error(
          `费用保险丝台账回滚无法持久化：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      this.host.notify('本机请求台账回滚暂时无法持久化；当前内存状态已移除未发出的请求。');
    }
  }

  async finish(
    event: ProviderUsageEvent,
    status: 'succeeded' | 'failed' | 'cancelled',
    knownCostEstimate?: ChatMessage['costEstimate']
  ): Promise<void> {
    const completed = completeProviderUsageEvent(event, {
      status,
      completedAt: this.host.now(),
      ...(knownCostEstimate ? { knownCostEstimate } : {}),
    });
    try {
      await this.persist([completed]);
    } catch {
      // The provider request already completed. Preserve the started unknown-cost
      // attempt instead of rewriting it as a falsely precise zero-cost result.
    }
  }
}
