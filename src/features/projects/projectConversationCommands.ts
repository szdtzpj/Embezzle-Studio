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
  | { type: 'artifact.delete'; artifactId: string }
  | { type: 'artifact.to-knowledge'; artifactId: string }
  | { type: 'artifact.from-message'; message: ChatMessage }
  | { type: 'knowledge.create'; title: string; content: string }
  | { type: 'knowledge.from-message'; message: ChatMessage }
  | { type: 'knowledge.update'; sourceId: string; title: string; content: string }
  | { type: 'knowledge.delete'; sourceId: string }
  | { type: 'knowledge.import'; picked: PickedKnowledgeTextFile };
