import { useContext, useEffect, useRef } from 'react';

import {
  ChatProjectNavigationContext,
  type ChatProjectNavigationPort,
} from './internal/ChatProjectNavigationContext';

export type { ChatProjectNavigationPort } from './internal/ChatProjectNavigationContext';

export function useChatProjectNavigation(): ChatProjectNavigationPort {
  const value = useContext(ChatProjectNavigationContext);
  if (!value) throw new Error('useChatProjectNavigation requires ChatProvider.');
  return {
    resetComposer: () => value.portRef.current?.resetComposer(),
    discardPendingAttachments: () => value.portRef.current?.discardPendingAttachments(),
    clearTaskQueries: () => value.portRef.current?.clearTaskQueries(),
    revealMessage: (messageId) => value.portRef.current?.revealMessage(messageId),
    applyPromptTemplate: (templateId) => value.portRef.current?.applyPromptTemplate(templateId),
    showNotice: (message) => value.portRef.current?.showNotice(message),
  };
}

/** Chat UI registers private implementation without exposing its draft state. */
export function useRegisterChatProjectNavigation(port: ChatProjectNavigationPort): void {
  const value = useContext(ChatProjectNavigationContext);
  if (!value) throw new Error('useRegisterChatProjectNavigation requires ChatProvider.');
  const latestPortRef = useRef(port);
  latestPortRef.current = port;
  useEffect(() => {
    const registeredPort: ChatProjectNavigationPort = {
      resetComposer: () => latestPortRef.current.resetComposer(),
      discardPendingAttachments: () => latestPortRef.current.discardPendingAttachments(),
      clearTaskQueries: () => latestPortRef.current.clearTaskQueries(),
      revealMessage: (messageId) => latestPortRef.current.revealMessage(messageId),
      applyPromptTemplate: (templateId) => latestPortRef.current.applyPromptTemplate(templateId),
      showNotice: (message) => latestPortRef.current.showNotice(message),
    };
    value.portRef.current = registeredPort;
    return () => {
      if (value.portRef.current === registeredPort) value.portRef.current = null;
    };
  }, [value.portRef]);
}
