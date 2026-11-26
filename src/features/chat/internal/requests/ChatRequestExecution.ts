import type {
  ActivityTimelineStep,
  AppWorkspace,
  ChatCompletionResult,
  ChatMessage,
  ImageGenerationOptions,
  McpActivitySummary,
  ModelInfo,
  ModelParameterSettings,
  PluginManifest,
  ProviderProfile,
  ProviderUsageEvent,
  ReasoningEffort,
} from '../../../../domain/types';
import {
  finalizeActivityTimelineForTerminalMessage,
  finalizeToolActivityForTerminalMessage,
} from '../../../../services/messageActivity';
import { estimateMessageCost } from '../../../../services/usageAnalytics';
import { inferModelTask } from '../../../../services/modelCapabilities';
import {
  assertMcpProviderSendAllowed,
  type McpAuditCandidate,
} from '../../../../services/mcpLifecycle';
import type {
  ProviderMcpApprovalDecision,
  ProviderMcpApprovalRequest,
} from '../../../../services/providerMcp';
import type { ProviderRequestPlan } from '../../../../services/costGuard';
import type { McpApprovalViewModel } from '../../../../components/McpApprovalModal';
import type { ChatOrchestrationController } from '../ChatContext';
import type { ProviderAdapterRegistry } from '../../orchestration/ProviderAdapterRegistry';

export type AssistantRequestOutcome =
  | { status: 'success' }
  | { status: 'cancelled'; mcpAudit?: McpAuditCandidate }
  | { status: 'error'; error: string; mcpAudit?: McpAuditCandidate };

export interface ChatRequestRuntimeTarget {
  provider: ProviderProfile;
  model: ModelInfo;
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ChatRequestExecutionPlan {
  assistantMessage: ChatMessage;
  conversationId: string;
  transcript: ChatMessage[];
  runtime: ChatRequestRuntimeTarget;
  controller: AbortController;
  usageEvent: ProviderUsageEvent;
  parameterSettings: ModelParameterSettings;
  imageOptions?: ImageGenerationOptions;
  finishRequest?: boolean;
  announceCancellation?: boolean;
}

type McpApprovalPresentation = Omit<
  McpApprovalViewModel,
  | 'approvalRequestId'
  | 'approvalNonce'
  | 'serverLabel'
  | 'toolName'
  | 'argumentsText'
  | 'argumentBytes'
>;

/** Internal adapter implemented by the Chat React host and deterministic tests. */
export interface ChatRequestExecutionHost {
  readWorkspace(): AppWorkspace;
  appState(): 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  streamUpdateDelayMs(): number;
  discardAttachments(attachments: NonNullable<ChatCompletionResult['attachments']>): Promise<void>;
  authorize(plan: ProviderRequestPlan, signal?: AbortSignal): Promise<boolean>;
  persistUsageEvents(events: readonly ProviderUsageEvent[]): Promise<void>;
  finishUsageEvent(
    event: ProviderUsageEvent,
    status: 'succeeded' | 'failed' | 'cancelled',
    knownCostEstimate?: ChatMessage['costEstimate']
  ): Promise<void>;
  requestMcpApproval(
    request: ProviderMcpApprovalRequest,
    presentation: McpApprovalPresentation,
    signal?: AbortSignal
  ): Promise<ProviderMcpApprovalDecision>;
  updateAssistantMessage(
    messageId: string,
    patch: Partial<ChatMessage>,
    conversationId: string
  ): void;
  notify(message: string): void;
}

export function enabledRemoteMcpPluginsForProvider(
  workspace: AppWorkspace,
  providerId: string
): PluginManifest[] {
  return workspace.plugins.filter(
    (plugin) =>
      plugin.type === 'remote-mcp' &&
      plugin.enabled === true &&
      plugin.providerId === providerId
  );
}

/**
 * Owns a provider call after request-start ordering has durably committed the
 * usage attempt and visible messages. Callers cannot reorder stream handling,
 * continuation authorization, MCP audit retention, terminal freezing, cost
 * projection, usage completion, or lease release.
 */
export class ChatRequestExecution {
  constructor(
    private readonly providers: ProviderAdapterRegistry,
    private readonly orchestration: ChatOrchestrationController,
    private readonly host: ChatRequestExecutionHost
  ) {}

  async execute({
    assistantMessage,
    conversationId,
    transcript,
    runtime,
    controller,
    usageEvent,
    parameterSettings,
    imageOptions,
    finishRequest = true,
    announceCancellation = true,
  }: ChatRequestExecutionPlan): Promise<AssistantRequestOutcome> {
    const startedAt = Date.now();
    let trackedUsageEvent = usageEvent;
    let pendingMcpActivity: McpActivitySummary | undefined;
    let mcpProviderSendStarted = false;
    let firstTokenAt: number | undefined;
    let latestUpdate:
      | Pick<
          ChatCompletionResult,
          | 'content'
          | 'reasoningContent'
          | 'thinkingDurationMs'
          | 'usage'
          | 'citations'
          | 'webSearchTriggered'
          | 'toolActivity'
          | 'activityTimeline'
        >
      | undefined;
    let streamTimer: ReturnType<typeof setTimeout> | null = null;

    const publishLatestUpdate = () => {
      if (!latestUpdate) return;
      this.host.updateAssistantMessage(
        assistantMessage.id,
        {
          content: latestUpdate.content,
          reasoningContent: latestUpdate.reasoningContent,
          ...(latestUpdate.thinkingDurationMs !== undefined
            ? { thinkingDurationMs: latestUpdate.thinkingDurationMs }
            : {}),
          usage: latestUpdate.usage,
          ...(latestUpdate.citations !== undefined
            ? { citations: latestUpdate.citations }
            : {}),
          ...(latestUpdate.webSearchTriggered !== undefined
            ? { webSearchTriggered: latestUpdate.webSearchTriggered }
            : {}),
          ...(latestUpdate.toolActivity ? { toolActivity: latestUpdate.toolActivity } : {}),
          ...(latestUpdate.activityTimeline
            ? { activityTimeline: latestUpdate.activityTimeline }
            : {}),
          status: 'pending',
        },
        conversationId
      );
    };

    try {
      const enabledMcpPlugins = enabledRemoteMcpPluginsForProvider(
        this.host.readWorkspace(),
        runtime.provider.id
      );
      if (enabledMcpPlugins.length > 1) {
        throw new Error('同一服务商存在多个已启用 MCP，已按安全策略拒绝发起请求。');
      }
      const mcpPlugin = enabledMcpPlugins[0];
      if (mcpPlugin?.serverLabel) {
        pendingMcpActivity = {
          serverLabel: mcpPlugin.serverLabel,
          providerRequestCount: 1,
          approvals: [],
          calls: [],
        };
      }

      const providerAdapter = this.providers.resolve(
        { provider: runtime.provider, modelId: runtime.modelId, model: runtime.model },
        'chat'
      );
      const result = await providerAdapter.run({
        provider: runtime.provider,
        modelId: runtime.modelId,
        model: runtime.model,
        messages: transcript,
        reasoningEffort: runtime.reasoningEffort,
        parameterSettings,
        ...(imageOptions ? { imageOptions } : {}),
        maxOutputTokens: this.host.readWorkspace().costGuard.enabled
          ? this.host.readWorkspace().costGuard.maxOutputTokens
          : undefined,
        webSearch: this.host.readWorkspace().webSearch,
        externalSearch: this.host.readWorkspace().externalSearch,
        beforeExternalSearchProviderRequest: async (context) => {
          this.assertCurrentProviderSendAllowed(controller, context.signal);
          if (context.requestNumber <= trackedUsageEvent.providerRequestCount) return;
          const authorized = await this.host.authorize({
            operations: [this.providerRequestOperation(runtime, true)],
          }, context.signal ?? controller.signal);
          if (!authorized || context.signal?.aborted) {
            throw abortError('外部搜索后续请求已取消。');
          }
          const nextUsageEvent = {
            ...trackedUsageEvent,
            providerRequestCount: context.requestNumber,
          };
          await this.host.persistUsageEvents([nextUsageEvent]);
          trackedUsageEvent = nextUsageEvent;
          this.assertCurrentProviderSendAllowed(controller, context.signal);
        },
        ...(mcpPlugin
          ? {
              mcp: {
                plugin: mcpPlugin,
                beforeProviderRequest: (context) => {
                  this.assertCurrentMcpProviderSendAllowed(controller, context.signal);
                },
                onProviderRequestStarted: (context) => {
                  mcpProviderSendStarted = true;
                  if (pendingMcpActivity) {
                    pendingMcpActivity.providerRequestCount = context.requestNumber;
                  }
                },
                requestApproval: async (request, context) => {
                  const decision = await this.host.requestMcpApproval(
                    request,
                    {
                      providerName: runtime.provider.name,
                      modelId: runtime.modelId,
                      serverName: mcpPlugin.name,
                      endpoint: mcpPlugin.endpoint ?? '无效 Endpoint',
                    },
                    context.signal
                  );
                  if (pendingMcpActivity && (decision === 'approve' || decision === 'deny')) {
                    pendingMcpActivity.approvals.push({ toolName: request.toolName, decision });
                  }
                  return decision;
                },
                beforeContinuation: async (context) => {
                  const authorized = await this.host.authorize({
                    operations: [this.providerRequestOperation(runtime, false)],
                  }, context.signal ?? controller.signal);
                  if (!authorized || context.signal?.aborted) {
                    throw abortError('MCP 续接请求已取消。');
                  }
                  const nextUsageEvent = {
                    ...trackedUsageEvent,
                    providerRequestCount: trackedUsageEvent.providerRequestCount + 1,
                  };
                  await this.host.persistUsageEvents([nextUsageEvent]);
                  trackedUsageEvent = nextUsageEvent;
                  this.assertCurrentMcpProviderSendAllowed(controller, context.signal);
                  if (pendingMcpActivity) {
                    pendingMcpActivity.providerRequestCount = nextUsageEvent.providerRequestCount;
                    for (const approval of context.approvals) {
                      if (approval.decision === 'approve') {
                        pendingMcpActivity.calls.push({
                          toolName: approval.toolName,
                          outcome: 'unknown',
                        });
                      }
                    }
                  }
                },
              },
            }
          : {}),
        onStreamUpdate: (update) => {
          if (
            update.content ||
            update.reasoningContent ||
            update.toolActivity?.length ||
            update.activityTimeline?.length
          ) {
            firstTokenAt ??= Date.now();
          }
          // 保留先前已流出的 thinkingDurationMs/citations/webSearchTriggered，避免后续纯文本分片将其覆盖
          latestUpdate = {
            ...update,
            ...(update.thinkingDurationMs === undefined &&
            latestUpdate?.thinkingDurationMs !== undefined
              ? { thinkingDurationMs: latestUpdate.thinkingDurationMs }
              : {}),
            ...(update.citations === undefined && latestUpdate?.citations !== undefined
              ? { citations: latestUpdate.citations }
              : {}),
            ...(update.webSearchTriggered === undefined &&
            latestUpdate?.webSearchTriggered !== undefined
              ? { webSearchTriggered: latestUpdate.webSearchTriggered }
              : {}),
          };
          if (!streamTimer) {
            streamTimer = setTimeout(() => {
              streamTimer = null;
              publishLatestUpdate();
            }, this.host.streamUpdateDelayMs());
          }
        },
        signal: controller.signal,
      });

      // 先清理节流定时器再处理可能的异步附件丢弃，防止 abort 后延迟触发 publishLatestUpdate
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;

      if (controller.signal.aborted) {
        await this.host.discardAttachments(result.attachments ?? []);
        throw abortError('请求已停止。');
      }

      const endedAt = Date.now();
      const requestMetrics = {
        durationMs: endedAt - startedAt,
        ...(firstTokenAt !== undefined ? { timeToFirstTokenMs: firstTokenAt - startedAt } : {}),
      };
      const resolvedThinkingDurationMs = resolveTerminalThinkingDurationMs(
        result.thinkingDurationMs,
        latestUpdate?.thinkingDurationMs,
        result.activityTimeline,
        result.reasoningContent,
        endedAt
      );
      const completedMessage: ChatMessage = {
        ...assistantMessage,
        content: result.content,
        reasoningContent: result.reasoningContent,
        ...(resolvedThinkingDurationMs !== undefined
          ? { thinkingDurationMs: resolvedThinkingDurationMs }
          : {}),
        ...(result.providerContinuations?.length
          ? { providerContinuations: result.providerContinuations }
          : {}),
        usage: result.usage,
        ...(result.toolActivity ? { toolActivity: result.toolActivity } : {}),
        ...(result.activityTimeline ? { activityTimeline: result.activityTimeline } : {}),
        status: 'ready',
        requestMetrics,
      };
      const pricing = this.host
        .readWorkspace()
        .modelPricing.filter(
          (item) =>
            item.providerId === assistantMessage.providerId &&
            item.modelId === assistantMessage.modelId
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      const costEstimate = estimateMessageCost(completedMessage, pricing);

      // 合并为单次终态提交，保留 M1 thinkingDurationMs 与 providerContinuations 落盘契约
      this.host.updateAssistantMessage(
        assistantMessage.id,
        {
          content: result.content,
          reasoningContent: result.reasoningContent,
          ...(resolvedThinkingDurationMs !== undefined
            ? { thinkingDurationMs: resolvedThinkingDurationMs }
            : {}),
          ...(result.providerContinuations?.length
            ? { providerContinuations: result.providerContinuations }
            : {}),
          usage: result.usage,
          citations: result.citations,
          webSearchTriggered: result.webSearchTriggered,
          ...(result.toolActivity ? { toolActivity: result.toolActivity } : {}),
          ...(result.activityTimeline ? { activityTimeline: result.activityTimeline } : {}),
          attachments: result.attachments,
          generationTask: result.generationTask,
          mcpActivity: result.mcpActivity,
          requestMetrics,
          ...(costEstimate ? { costEstimate } : { costEstimate: undefined }),
          status: 'ready',
          error: undefined,
        },
        conversationId
      );
      await this.host.finishUsageEvent(trackedUsageEvent, 'succeeded', costEstimate ?? undefined);
      return { status: 'success' };
    } catch (error) {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;

      if (isAbortError(error) || controller.signal.aborted) {
        const mcpAudit = mcpAuditCandidate(
          pendingMcpActivity,
          mcpProviderSendStarted,
          'cancelled'
        );
        const endedAt = Date.now();
        const activityTimeline = finalizeActivityTimelineForTerminalMessage(
          latestUpdate?.activityTimeline,
          { messageStatus: 'cancelled', finishedAt: endedAt }
        );
        const toolActivity = finalizeToolActivityForTerminalMessage(
          latestUpdate?.toolActivity,
          'cancelled',
          endedAt
        );
        const resolvedThinkingDurationMs = resolveTerminalThinkingDurationMs(
          undefined,
          latestUpdate?.thinkingDurationMs,
          activityTimeline,
          latestUpdate?.reasoningContent,
          endedAt
        );
        this.host.updateAssistantMessage(
          assistantMessage.id,
          {
            content: latestUpdate?.content || '生成已停止。',
            reasoningContent: latestUpdate?.reasoningContent,
            ...(resolvedThinkingDurationMs !== undefined
              ? { thinkingDurationMs: resolvedThinkingDurationMs }
              : {}),
            usage: latestUpdate?.usage,
            ...(latestUpdate?.citations !== undefined
              ? { citations: latestUpdate.citations }
              : {}),
            ...(latestUpdate?.webSearchTriggered !== undefined
              ? { webSearchTriggered: latestUpdate.webSearchTriggered }
              : {}),
            status: 'cancelled',
            error: undefined,
            requestMetrics: {
              durationMs: endedAt - startedAt,
              ...(firstTokenAt !== undefined
                ? { timeToFirstTokenMs: firstTokenAt - startedAt }
                : {}),
            },
            ...(activityTimeline ? { activityTimeline } : {}),
            ...(toolActivity ? { toolActivity } : {}),
            ...(mcpAudit ? { mcpActivity: pendingMcpActivity } : {}),
          },
          conversationId
        );
        if (announceCancellation) this.host.notify('已停止生成，已保留收到的内容。');
        await this.host.finishUsageEvent(trackedUsageEvent, 'cancelled');
        return { status: 'cancelled', ...(mcpAudit ? { mcpAudit } : {}) };
      }

      const message = error instanceof Error ? error.message : '对话请求失败。';
      const mcpAudit = mcpAuditCandidate(
        pendingMcpActivity,
        mcpProviderSendStarted,
        'error',
        message
      );
      const endedAt = Date.now();
      const activityTimeline = finalizeActivityTimelineForTerminalMessage(
        latestUpdate?.activityTimeline,
        { messageStatus: 'error', finishedAt: endedAt }
      );
      const toolActivity = finalizeToolActivityForTerminalMessage(
        latestUpdate?.toolActivity,
        'error',
        endedAt
      );
      const resolvedThinkingDurationMs = resolveTerminalThinkingDurationMs(
        undefined,
        latestUpdate?.thinkingDurationMs,
        activityTimeline,
        latestUpdate?.reasoningContent,
        endedAt
      );
      this.host.updateAssistantMessage(
        assistantMessage.id,
        {
          content: latestUpdate?.content || message,
          reasoningContent: latestUpdate?.reasoningContent,
          ...(resolvedThinkingDurationMs !== undefined
            ? { thinkingDurationMs: resolvedThinkingDurationMs }
            : {}),
          usage: latestUpdate?.usage,
          ...(latestUpdate?.citations !== undefined
            ? { citations: latestUpdate.citations }
            : {}),
          ...(latestUpdate?.webSearchTriggered !== undefined
            ? { webSearchTriggered: latestUpdate.webSearchTriggered }
            : {}),
          status: 'error',
          error: message,
          requestMetrics: {
            durationMs: endedAt - startedAt,
            ...(firstTokenAt !== undefined
              ? { timeToFirstTokenMs: firstTokenAt - startedAt }
              : {}),
          },
          ...(activityTimeline ? { activityTimeline } : {}),
          ...(toolActivity ? { toolActivity } : {}),
          ...(mcpAudit ? { mcpActivity: pendingMcpActivity } : {}),
        },
        conversationId
      );
      await this.host.finishUsageEvent(trackedUsageEvent, 'failed');
      return { status: 'error', error: message, ...(mcpAudit ? { mcpAudit } : {}) };
    } finally {
      if (finishRequest) this.finishRequest(controller);
    }
  }

  private providerRequestOperation(
    runtime: ChatRequestRuntimeTarget,
    searchEnabled: boolean
  ): ProviderRequestPlan['operations'][number] {
    const task = inferModelTask(runtime.model);
    const kind = searchEnabled
      ? 'web-search'
      : task === 'image-generation'
        ? 'image-generation'
        : task === 'video-generation'
          ? 'video-generation'
          : 'chat';
    const mcpEnabled =
      task === 'chat' &&
      enabledRemoteMcpPluginsForProvider(
        this.host.readWorkspace(),
        runtime.provider.id
      ).length > 0;
    return {
      kind,
      providerId: runtime.provider.id,
      modelId: runtime.modelId,
      ...(mcpEnabled ? { unknownCostComponents: ['provider-surcharge'] as const } : {}),
    };
  }

  private assertCurrentProviderSendAllowed(
    controller: AbortController,
    signal?: AbortSignal
  ): void {
    if (
      this.orchestration.current()?.controller !== controller ||
      controller.signal.aborted ||
      signal?.aborted === true
    ) {
      throw abortError('当前服务商请求已停止。');
    }
  }

  private assertCurrentMcpProviderSendAllowed(
    controller: AbortController,
    signal?: AbortSignal
  ): void {
    const activeRequest = this.orchestration.current();
    assertMcpProviderSendAllowed({
      requestIsCurrent: activeRequest?.controller === controller,
      mcpActive: activeRequest?.mcpActive === true,
      signalAborted: controller.signal.aborted || signal?.aborted === true,
      appState: this.host.appState(),
    });
  }

  private finishRequest(controller: AbortController): void {
    const activeRequest = this.orchestration.current();
    if (activeRequest?.controller === controller) this.orchestration.finish(activeRequest);
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * 终态思考耗时兜底派生：优先保留适配器显式返回的 thinkingDurationMs；
 * 仅在缺失时依据 activityTimeline 中具备实质推理文本的 thinking 步骤累计耗时，
 * 避免为无推理占位步骤伪造耗时。
 */
function resolveTerminalThinkingDurationMs(
  explicitDurationMs: number | undefined,
  fallbackUpdateDurationMs: number | undefined,
  activityTimeline: readonly ActivityTimelineStep[] | undefined,
  reasoningContent: string | undefined,
  endedAt: number
): number | undefined {
  if (typeof explicitDurationMs === 'number' && Number.isFinite(explicitDurationMs)) {
    return explicitDurationMs;
  }
  if (typeof fallbackUpdateDurationMs === 'number' && Number.isFinite(fallbackUpdateDurationMs)) {
    return fallbackUpdateDurationMs;
  }
  if (!activityTimeline?.length) return undefined;
  const thinkingSteps = activityTimeline.filter(
    (step) => step.kind === 'thinking' && typeof step.startedAt === 'number'
  );
  if (!thinkingSteps.length) return undefined;
  const hasSubstantiveThinking =
    Boolean(reasoningContent?.trim()) ||
    thinkingSteps.some((step) => Boolean(step.content?.trim()));
  if (!hasSubstantiveThinking) return undefined;
  return thinkingSteps.reduce(
    (total, step) =>
      total + Math.max(0, (step.finishedAt ?? endedAt) - (step.startedAt as number)),
    0
  );
}

function mcpAuditCandidate(
  activity: McpActivitySummary | undefined,
  providerSendStarted: boolean,
  status: 'cancelled' | 'error',
  error?: string
): McpAuditCandidate | undefined {
  if (
    !activity ||
    (!providerSendStarted && activity.approvals.length === 0 && activity.calls.length === 0)
  ) {
    return undefined;
  }
  return {
    status,
    activity,
    providerSendStarted,
    ...(error ? { error } : {}),
  };
}
