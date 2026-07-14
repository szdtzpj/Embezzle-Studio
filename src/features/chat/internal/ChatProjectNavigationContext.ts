import { createContext } from 'react';

export interface ChatProjectNavigationPort {
  resetComposer(): void;
  /** Drop unsent media when the provider/model/workspace target changes. */
  discardPendingAttachments(): void;
  clearTaskQueries(): void;
  revealMessage(messageId: string): void;
  applyPromptTemplate(templateId: string): void;
  showNotice(message: string): void;
}

export interface ChatProjectNavigationContextValue {
  portRef: { current: ChatProjectNavigationPort | null };
}

export const ChatProjectNavigationContext =
  createContext<ChatProjectNavigationContextValue | null>(null);
