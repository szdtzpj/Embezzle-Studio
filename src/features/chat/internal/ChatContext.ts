import { createContext } from 'react';

import type { ChatActivity, ChatActivityPhase } from '../useChatActivity';
import type { ChatProviderAdapters } from '../ChatProvider';

export interface ChatLease {
  controller: AbortController;
  label: string;
  phase: Exclude<ChatActivityPhase, 'idle'>;
  mcpActive: boolean;
}

export interface ChatOrchestrationController {
  current(): ChatLease | null;
  begin(options: {
    phase: Exclude<ChatActivityPhase, 'idle'>;
    label: string;
    mcpActive?: boolean;
  }): ChatLease | null;
  transition(lease: ChatLease, phase: Exclude<ChatActivityPhase, 'idle'>): boolean;
  finish(lease: ChatLease): void;
  stop(): void;
}

export interface ChatContextValue {
  activity: ChatActivity;
  orchestration: ChatOrchestrationController;
  adapters: ChatProviderAdapters;
}

export const ChatContext = createContext<ChatContextValue | null>(null);
