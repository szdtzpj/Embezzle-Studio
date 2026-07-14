import { useContext } from 'react';

import { ChatContext } from './internal/ChatContext';

export type ChatActivityPhase =
  | 'idle'
  | 'authorizing'
  | 'provider-request'
  | 'audio'
  | 'task-query';

export interface ChatActivity {
  phase: ChatActivityPhase;
  label?: string;
  configurationLocked: boolean;
  historyLocked: boolean;
  stop(): void;
}

export function useChatActivity(): ChatActivity {
  const value = useContext(ChatContext);
  if (!value) {
    throw new Error('useChatActivity requires ChatProvider.');
  }
  return value.activity;
}
