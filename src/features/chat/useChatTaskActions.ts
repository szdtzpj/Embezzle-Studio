import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useWorkspaceSession } from '../../app/workspace/WorkspaceSessionProvider';
import type { ChatMessage, GenerationTaskInfo } from '../../domain/types';
import { canonicalMessageId } from '../../services/conversationBranches';
import { discardUncommittedAttachments } from '../../services/mediaStorage';
import { isAbortError } from '../../services/openAiCompatible';
import type { ChatOrchestrationController } from './internal/ChatContext';
import { ChatWorkspaceRuntime } from './internal/ChatWorkspaceRuntime';
import type { ProviderAdapterRegistry } from './orchestration/ProviderAdapterRegistry';
import { ChatTaskLeaseCoordinator } from './orchestration/ChatTaskLease';

export interface ChatTaskRefreshResult {
  status: 'updated' | 'ignored' | 'rejected';
  notice?: string;
}

export interface ChatTaskActions {
  queryingByMessageId: Readonly<Record<string, boolean>>;
  refresh(message: ChatMessage, task: GenerationTaskInfo): Promise<ChatTaskRefreshResult>;
}

export interface ChatTaskRuntime extends ChatTaskActions {
  cancelAll(): void;
}

const ChatTaskRuntimeContext = createContext<ChatTaskRuntime | null>(null);

/**
 * Public point-to-point Chat capability for the Settings task center. Provider
 * lookup, cancellation, activity leases and workspace projection stay inside Chat.
 */
export function ChatTaskRuntimeProvider(props: {
  children: ReactNode;
  orchestration: ChatOrchestrationController;
  providerRegistry: ProviderAdapterRegistry;
}): ReactElement {
  const session = useWorkspaceSession();
  const runtime = useMemo(() => new ChatWorkspaceRuntime(session), [session]);
  const { orchestration, providerRegistry } = props;
  const [queryingByMessageId, setQueryingByMessageId] = useState<Record<string, boolean>>({});
  const leaseCoordinator = useMemo(
    () => new ChatTaskLeaseCoordinator(orchestration, setQueryingByMessageId),
    [orchestration]
  );

  const cancelAll = useCallback(() => {
    leaseCoordinator.cancelAll();
  }, [leaseCoordinator]);

  useEffect(() => () => leaseCoordinator.dispose(), [leaseCoordinator]);

  const refresh = useCallback(
    async (message: ChatMessage, task: GenerationTaskInfo): Promise<ChatTaskRefreshResult> => {
      if (session.getStatus().phase !== 'ready') {
        return { status: 'rejected', notice: '工作区当前只读或正在替换，无法刷新媒体任务。' };
      }
      const provider = session.getSnapshot().providers.find((item) => item.id === task.providerId);
      if (!provider || provider.enabled === false) {
        return {
          status: 'rejected',
          notice: '这个媒体任务对应的服务商已禁用；请先重新启用后再刷新。',
        };
      }

      const start = leaseCoordinator.start(message.id);
      if (!start.ok) {
        return {
          status: 'rejected',
          notice: `${start.busyLabel}仍在进行中，请稍后刷新任务。`,
        };
      }
      const { controller } = start;

      try {
        const adapter = providerRegistry.resolve(
          { provider, modelId: task.modelId },
          'generation-task'
        );
        const result = await adapter.queryTask({ provider, task, signal: controller.signal });
        const canonicalId = canonicalMessageId(message);
        const taskStillExists = session.getSnapshot().conversations.some((conversation) =>
          conversation.messages.some(
            (candidate) =>
              canonicalMessageId(candidate) === canonicalId &&
              candidate.generationTask?.taskId === task.taskId
          )
        );
        if (
          controller.signal.aborted ||
          session.getStatus().phase !== 'ready' ||
          !taskStillExists
        ) {
          await discardUncommittedAttachments(result.attachments ?? []);
          return { status: 'ignored' };
        }
        await runtime.execute({
          type: 'message.update-generation-copies',
          source: message,
          patch: {
            content: result.content,
            attachments: result.attachments ?? message.attachments,
            generationTask: result.generationTask,
            usage: result.usage ?? message.usage,
            status: 'ready',
            error: undefined,
          },
          now: Date.now(),
        });
        return { status: 'updated' };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return { status: 'ignored' };
        }
        const notice = error instanceof Error ? error.message : '生成任务查询失败。';
        await runtime.execute({
          type: 'message.update',
          messageId: message.id,
          patch: { status: 'error', error: notice },
          now: Date.now(),
        });
        return { status: 'rejected', notice };
      } finally {
        leaseCoordinator.finish(message.id, controller);
      }
    },
    [leaseCoordinator, providerRegistry, runtime, session]
  );

  const value = useMemo(
    () => ({ queryingByMessageId, refresh, cancelAll }),
    [cancelAll, queryingByMessageId, refresh]
  );

  return createElement(ChatTaskRuntimeContext.Provider, { value }, props.children);
}

export function useChatTaskRuntime(): ChatTaskRuntime {
  const runtime = useContext(ChatTaskRuntimeContext);
  if (!runtime) {
    throw new Error('useChatTaskRuntime requires ChatTaskRuntimeProvider.');
  }
  return runtime;
}

export function useChatTaskActions(): ChatTaskActions {
  const runtime = useChatTaskRuntime();
  return useMemo(
    () => ({ queryingByMessageId: runtime.queryingByMessageId, refresh: runtime.refresh }),
    [runtime.queryingByMessageId, runtime.refresh]
  );
}
