import { createContext } from 'react';
import type { MediaAttachment } from '../../../domain/types';

export interface ChatProjectNavigationPort {
  resetComposer(): void;
  /** Drop unsent media when the provider/model/workspace target changes. */
  discardPendingAttachments(): void;
  clearTaskQueries(): void;
  setComposerText(text: string): void;
  appendComposerText(text: string): void;
  addComposerAttachments(attachments: MediaAttachment[], textToAppend?: string): Promise<boolean>;
  showChat(): void;
  openArtifact(artifactId: string): void;
  revealMessage(messageId: string): void;
  applyPromptTemplate(templateId: string): void;
  showNotice(message: string): void;
}

export interface ChatProjectNavigationContextValue {
  portRef: { current: ChatProjectNavigationPort | null };
}

export const ChatProjectNavigationContext =
  createContext<ChatProjectNavigationContextValue | null>(null);
