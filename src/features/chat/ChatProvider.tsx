import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ApplicationLifecyclePort } from '../../app/lifecycle/applicationLifecyclePort';
import {
  ChatContext,
  type ChatLease,
  type ChatOrchestrationController,
} from './internal/ChatContext';
import type { ChatActivity, ChatActivityPhase } from './useChatActivity';
import type { ProviderAdapterRegistry } from './orchestration/ProviderAdapterRegistry';
import type { ChatAudioAdapter } from './orchestration/ChatAudioAdapter';
import {
  ChatProjectNavigationContext,
  type ChatProjectNavigationPort,
} from './internal/ChatProjectNavigationContext';
import { ChatTaskRuntimeProvider } from './useChatTaskActions';

export interface ChatProviderAdapters {
  lifecycle: ApplicationLifecyclePort;
  providers: ProviderAdapterRegistry;
  audio: ChatAudioAdapter;
  onActivityChange?: (activity: Pick<ChatActivity, 'configurationLocked' | 'historyLocked' | 'phase'>) => void;
}

function activityProjection(
  phase: ChatActivityPhase
): Pick<ChatActivity, 'configurationLocked' | 'historyLocked' | 'phase'> {
  return {
    phase,
    configurationLocked: phase !== 'idle',
    historyLocked: phase === 'provider-request' || phase === 'authorizing',
  };
}

/** Owns the single provider-affecting lease and public Chat activity projection. */
export function ChatProvider(props: {
  adapters: ChatProviderAdapters;
  children: ReactNode;
}): React.ReactElement {
  const currentRef = useRef<ChatLease | null>(null);
  const projectNavigationPortRef = useRef<ChatProjectNavigationPort | null>(null);
  const [phase, setPhase] = useState<ChatActivityPhase>('idle');
  const [label, setLabel] = useState<string | undefined>();

  const publishActivity = useCallback(
    (nextPhase: ChatActivityPhase) => {
      props.adapters.onActivityChange?.(activityProjection(nextPhase));
    },
    [props.adapters]
  );

  const finish = useCallback((lease: ChatLease) => {
    if (currentRef.current !== lease) {
      return;
    }
    currentRef.current = null;
    publishActivity('idle');
    setPhase('idle');
    setLabel(undefined);
  }, [publishActivity]);

  const stop = useCallback(() => {
    currentRef.current?.controller.abort();
  }, []);

  const orchestration = useMemo<ChatOrchestrationController>(
    () => ({
      current: () => currentRef.current,
      begin: (options) => {
        if (currentRef.current) {
          return null;
        }
        const lease: ChatLease = {
          controller: new AbortController(),
          label: options.label,
          phase: options.phase,
          mcpActive: options.mcpActive === true,
        };
        currentRef.current = lease;
        publishActivity(lease.phase);
        setPhase(lease.phase);
        setLabel(lease.label);
        return lease;
      },
      transition: (lease, nextPhase) => {
        if (currentRef.current !== lease || lease.controller.signal.aborted) {
          return false;
        }
        lease.phase = nextPhase;
        publishActivity(nextPhase);
        setPhase(nextPhase);
        return true;
      },
      finish,
      stop,
    }),
    [finish, publishActivity, stop]
  );

  useEffect(() => {
    publishActivity(currentRef.current?.phase ?? 'idle');
    return () => publishActivity('idle');
  }, [publishActivity]);

  useEffect(
    () => props.adapters.lifecycle.subscribe((event) => {
      const active = currentRef.current;
      if (event === 'background' && active?.mcpActive) {
        active.controller.abort();
      }
    }),
    [props.adapters.lifecycle]
  );

  const activity = useMemo<ChatActivity>(
    () => ({
      ...activityProjection(phase),
      ...(label ? { label } : {}),
      stop,
    }),
    [label, phase, stop]
  );

  const value = useMemo(
    () => ({ activity, orchestration, adapters: props.adapters }),
    [activity, orchestration, props.adapters]
  );

  return (
    <ChatContext.Provider value={value}>
      <ChatTaskRuntimeProvider
        orchestration={orchestration}
        providerRegistry={props.adapters.providers}
      >
        <ChatProjectNavigationContext.Provider value={{ portRef: projectNavigationPortRef }}>
          {props.children}
        </ChatProjectNavigationContext.Provider>
      </ChatTaskRuntimeProvider>
    </ChatContext.Provider>
  );
}

/** Internal capability for Chat implementation; not exported from the public barrel. */
export function useChatOrchestrationController(): ChatOrchestrationController {
  const value = useContext(ChatContext);
  if (!value) {
    throw new Error('useChatOrchestrationController requires ChatProvider.');
  }
  return value.orchestration;
}

export function useChatAdapters(): ChatProviderAdapters {
  const value = useContext(ChatContext);
  if (!value) {
    throw new Error('useChatAdapters requires ChatProvider.');
  }
  return value.adapters;
}
