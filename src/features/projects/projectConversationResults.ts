import type { MediaAttachment } from '../../domain/types';

export type ProjectConversationUiHints = {
  notice?: string;
  /** The committed active project, conversation, provider, or model changed. */
  activeContextChanged?: boolean;
  /** In-flight generation-task reads can no longer safely project into the result. */
  taskQueriesInvalidated?: boolean;
  createdArtifactId?: string;
};

export type ProjectConversationResult =
  | ({
      ok: true;
      /** Attachments that became unreferenced and should be deleted from disk. */
      orphanedAttachments?: MediaAttachment[];
    } & ProjectConversationUiHints)
  | ({
      ok: false;
      notice: string;
    } & ProjectConversationUiHints);

export interface ProjectConversationChatEffects {
  showNotice(message: string): void;
  resetComposer(): void;
  clearTaskQueries(): void;
}

/** Apply cross-feature Chat effects once so every Projects caller preserves them. */
export function applyProjectConversationChatEffects(
  result: ProjectConversationResult,
  effects: ProjectConversationChatEffects
): void {
  if (result.notice !== undefined) effects.showNotice(result.notice);
  if (result.activeContextChanged) effects.resetComposer();
  if (result.taskQueriesInvalidated) effects.clearTaskQueries();
}
