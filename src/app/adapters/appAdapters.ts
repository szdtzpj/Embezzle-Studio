import { createExpoApplicationLifecycleAdapter } from '../lifecycle/expoApplicationLifecycleAdapter';
import type { ApplicationLifecyclePort } from '../lifecycle/applicationLifecyclePort';
import { createExpoWorkspacePersistenceAdapter } from '../workspace/adapters/expoWorkspacePersistenceAdapter';
import type { WorkspacePersistenceAdapter } from '../workspace/adapters/workspacePersistenceAdapter';
import type { ChatProviderAdapters } from '../../features/chat';
import type { ProjectsConversationsPorts } from '../../features/projects';
import { createProductionProviderAdapterRegistry } from '../../features/chat/orchestration/ProviderAdapterRegistry';
import { createProductionChatAudioAdapter } from '../../features/chat/orchestration/ChatAudioAdapter';

export interface AppAdapters {
  chat: ChatProviderAdapters;
  projects: ProjectsConversationsPorts;
  workspace: {
    persistence: WorkspacePersistenceAdapter;
    lifecycle: ApplicationLifecyclePort;
  };
}

/**
 * Production adapter assembly. Kept explicit so App.tsx composition root remains
 * a readable map of seams rather than a one-line re-export.
 */
export function createAppAdapters(): AppAdapters {
  const lifecycle = createExpoApplicationLifecycleAdapter();
  const persistence = createExpoWorkspacePersistenceAdapter();
  let historyLocked = false;
  return {
    chat: {
      lifecycle,
      providers: createProductionProviderAdapterRegistry(),
      audio: createProductionChatAudioAdapter(),
      onActivityChange: (activity) => {
        historyLocked = activity.historyLocked;
      },
    },
    projects: {
      isHistoryLocked: () => historyLocked,
    },
    workspace: {
      persistence,
      lifecycle,
    },
  };
}

export const appAdapters: AppAdapters = createAppAdapters();
