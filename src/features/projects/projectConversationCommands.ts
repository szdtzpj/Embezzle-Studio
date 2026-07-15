import type {
  ChatMessage,
  WorkspaceArtifactFormat,
} from '../../domain/types';
import type { PickedKnowledgeTextFile } from '../../services/knowledgeFileIO';

export type ProjectInput = {
  name: string;
  systemPrompt?: string;
};

export type ProjectPatch = {
  name?: string;
  systemPrompt?: string | null;
  defaultTarget?: { providerId: string; modelId: string } | null;
};

export type ProjectConversationCommand =
  | { type: 'project.create'; input: ProjectInput; successNotice?: string }
  | { type: 'project.update'; projectId: string; patch: ProjectPatch }
  | { type: 'project.delete'; projectId: string; fallbackProjectId: string }
  | { type: 'project.activate'; projectId: string }
  | { type: 'project.setDefaultTarget'; projectId: string; providerId: string; modelId: string }
  | { type: 'conversation.start'; projectId?: string; noticeText?: string }
  | { type: 'conversation.activate'; conversationId: string }
  | { type: 'conversation.move'; conversationId: string; projectId: string }
  | { type: 'conversation.fork'; conversationId: string; messageId: string }
  | { type: 'conversation.delete'; conversationId: string }
  | { type: 'conversation.rename'; conversationId: string; title: string }
  | { type: 'conversation.pin'; conversationId: string; pinned: boolean }
  | { type: 'conversation.toggle-knowledge'; sourceId: string }
  | { type: 'artifact.create'; format: WorkspaceArtifactFormat }
  | { type: 'artifact.save'; artifactId: string; title: string; content: string }
  | { type: 'artifact.restore'; artifactId: string; sourceRevisionId: string }
  | { type: 'artifact.set-favorite'; artifactId: string; favorite: boolean }
  | { type: 'artifact.set-tags'; artifactId: string; tags: string[] }
  | { type: 'artifact.move'; artifactId: string; projectId: string }
  | { type: 'artifact.delete'; artifactId: string }
  | { type: 'artifact.to-knowledge'; artifactId: string }
  | { type: 'artifact.from-message'; message: ChatMessage }
  | { type: 'knowledge.create'; title: string; content: string }
  | { type: 'knowledge.from-message'; message: ChatMessage }
  | { type: 'knowledge.update'; sourceId: string; title: string; content: string }
  | { type: 'knowledge.delete'; sourceId: string }
  | { type: 'knowledge.import'; picked: PickedKnowledgeTextFile };

/**
 * Commands that can change the project/conversation/provider context used by
 * an in-flight provider request. They must be rejected while history is
 * locked; the drawer can still render and browse the current snapshot.
 */
export function changesProjectConversationRequestContext(
  command: ProjectConversationCommand
): boolean {
  switch (command.type) {
    case 'project.create':
    case 'project.update':
    case 'project.delete':
    case 'project.activate':
    case 'project.setDefaultTarget':
    case 'conversation.start':
    case 'conversation.activate':
    case 'conversation.move':
    case 'conversation.fork':
    case 'conversation.delete':
    case 'conversation.toggle-knowledge':
      return true;
    default:
      return false;
  }
}

export const PROJECT_CONVERSATION_HISTORY_LOCK_NOTICE =
  '当前仍有服务商请求进行中；本次操作未执行。';
