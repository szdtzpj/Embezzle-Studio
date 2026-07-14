import { useCallback, useMemo } from 'react';

import { useChatOrchestrationController } from './ChatProvider';

export type ChatConfigurationTaskResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'busy'; notice: string }
  | { ok: false; reason: 'error'; error: unknown };

export interface ChatConfigurationActions {
  run<T>(
    label: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<ChatConfigurationTaskResult<T>>;
}

/** Narrow Settings-to-Chat port for provider configuration I/O serialization. */
export function useChatConfigurationActions(): ChatConfigurationActions {
  const orchestration = useChatOrchestrationController();
  const run = useCallback(
    async <T,>(
      label: string,
      task: (signal: AbortSignal) => Promise<T>
    ): Promise<ChatConfigurationTaskResult<T>> => {
      const lease = orchestration.begin({ phase: 'provider-request', label });
      if (!lease) {
        return {
          ok: false,
          reason: 'busy',
          notice: `${orchestration.current()?.label ?? '其他操作'}仍在进行中，请稍后重试。`,
        };
      }
      try {
        return { ok: true, value: await task(lease.controller.signal) };
      } catch (error) {
        return { ok: false, reason: 'error', error };
      } finally {
        orchestration.finish(lease);
      }
    },
    [orchestration]
  );

  return useMemo(() => ({ run }), [run]);
}
