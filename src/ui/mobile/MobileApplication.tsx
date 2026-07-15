import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { NotificationResponse } from 'expo-notifications';

import { useChatProjectNavigation } from '../../features/chat';
import { useWorkspaceSelector, useWorkspaceStatus } from '../../app/workspace/WorkspaceSessionProvider';
import { useWorkspaceSession } from '../../app/workspace/internal/WorkspaceSessionContext';
import { ChatPane } from '../../features/chat/ChatPane';
import { ProjectDrawer } from '../../features/projects/ProjectDrawer';
import { useProjectConversationNavigation } from '../../features/projects';
import { useGenerationTaskBackground } from '../../features/background';
import {
  FirstRunSetupWizard,
  SettingsPane,
  useSettingsLauncher,
} from '../../features/settings';
import {
  IncomingShareSheet,
  useIncomingShareInbox,
  type IncomingShareDestination,
} from '../../features/share';
import { discardUncommittedAttachments } from '../../services/mediaStorage';
import {
  clearLastGenerationTaskNotificationResponse,
  getLastGenerationTaskNotificationResponse,
  parseGenerationTaskNotificationResponse,
  subscribeToGenerationTaskNotificationResponses,
} from '../../services/generationTaskNotifications';
import { workspaceNeedsOnboarding } from '../../services/workspaceProductState';
import { AppDialogHost } from '../components/AppDialogHost';
import { MobileShell } from './MobileShell';

function shareText(snapshot: ReturnType<typeof useIncomingShareInbox>['snapshot']): string {
  return [...snapshot.text, ...snapshot.urls]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n\n');
}

function shareTitle(snapshot: ReturnType<typeof useIncomingShareInbox>['snapshot']): string {
  const first = shareText(snapshot).split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (first) return first.slice(0, 80);
  const attachment = snapshot.attachments.find((item) => item.name?.trim());
  return (attachment?.name?.trim() || '系统分享资料').replace(/\.[a-z0-9]{1,8}$/iu, '').slice(0, 80);
}

/** Owns application-level native roots and global overlays around semantic feature views. */
export function MobileApplication(): React.ReactElement {
  const settings = useSettingsLauncher();
  const projectChat = useChatProjectNavigation();
  const projectsNavigation = useProjectConversationNavigation();
  const workspaceSession = useWorkspaceSession();
  const generationBackground = useGenerationTaskBackground();
  const incomingShare = useIncomingShareInbox();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const status = useWorkspaceStatus();
  const [setupOpen, setSetupOpen] = useState(false);
  const [shareBusyDestination, setShareBusyDestination] = useState<IncomingShareDestination | null>(null);
  const [shareError, setShareError] = useState<string>();
  const projectChatRef = useRef(projectChat);
  const projectsNavigationRef = useRef(projectsNavigation);
  const workspaceSessionRef = useRef(workspaceSession);
  const generationBackgroundRef = useRef(generationBackground);
  const handledNotificationRef = useRef<string | null>(null);
  const handlingNotificationRef = useRef(new Set<string>());
  projectChatRef.current = projectChat;
  projectsNavigationRef.current = projectsNavigation;
  workspaceSessionRef.current = workspaceSession;
  generationBackgroundRef.current = generationBackground;

  useEffect(() => {
    if (status.phase === 'ready' && workspaceNeedsOnboarding(workspace)) {
      setSetupOpen(true);
    }
  }, [status.phase, workspace]);

  useEffect(() => {
    let disposed = false;
    const handleResponse = async (response: NotificationResponse): Promise<boolean> => {
      const route = parseGenerationTaskNotificationResponse(response);
      // Malformed notification data is not actionable; consume it so a stale
      // OS response cannot replay forever. Valid routes return false until
      // they have actually reached the target conversation/message.
      if (!route) return true;
      const key = `${route.taskId}:${route.conversationId ?? ''}:${route.messageId ?? ''}:${route.state}`;
      if (handledNotificationRef.current === key) return true;
      // Cold-start lookup and the live listener can deliver the same response
      // concurrently. Let the first delivery decide whether it is consumable;
      // the duplicate must not clear the OS-held response early.
      if (handlingNotificationRef.current.has(key)) return false;
      handlingNotificationRef.current.add(key);
      try {
        await workspaceSessionRef.current.boot();
        if (disposed) return false;
        if (workspaceSessionRef.current.getStatus().phase !== 'ready') {
          projectChatRef.current.showNotice('工作区尚未准备好，无法打开这条任务通知。');
          return false;
        }
        // Headless results live in the outbox until the foreground session has
        // durably applied them. Recover before revealing the target message.
        await generationBackgroundRef.current.recoverNow();
        if (disposed) return false;
        if (route.conversationId) {
          const result = await projectsNavigationRef.current.execute({
            type: 'conversation.activate',
            conversationId: route.conversationId,
          });
          if (!result.ok) {
            projectChatRef.current.showNotice(result.notice);
            return false;
          }
        }
        projectChatRef.current.showChat();
        if (route.messageId) projectChatRef.current.revealMessage(route.messageId);
        handledNotificationRef.current = key;
        return true;
      } finally {
        handlingNotificationRef.current.delete(key);
      }
    };
    void getLastGenerationTaskNotificationResponse().then((response) => {
      if (!disposed && response) {
        void handleResponse(response)
          .then((consumed) => {
            if (consumed) void clearLastGenerationTaskNotificationResponse();
          })
          .catch((error) => {
            projectChatRef.current.showNotice(
              error instanceof Error ? error.message : '打开任务通知失败，请稍后重试。'
            );
          });
      }
    });
    const subscription = subscribeToGenerationTaskNotificationResponses((response) => {
      void handleResponse(response)
        .then((consumed) => {
          if (consumed) void clearLastGenerationTaskNotificationResponse();
        })
        .catch((error) => {
          projectChatRef.current.showNotice(
          error instanceof Error ? error.message : '打开任务通知失败，请稍后重试。'
          );
        });
    });
    return () => {
      disposed = true;
      subscription?.remove();
    };
  }, []);

  async function commitIncomingShare(destination: IncomingShareDestination): Promise<void> {
    if (shareBusyDestination) return;
    setShareBusyDestination(destination);
    setShareError(undefined);
    const snapshot = incomingShare.snapshot;
    try {
      if (destination === 'conversation') {
        const attachments = await incomingShare.persistAttachments(snapshot);
        try {
          projectChat.showChat();
          const text = shareText(snapshot);
          if (!(await projectChat.addComposerAttachments(attachments, text))) {
            throw new Error('当前对话无法加入这些附件，请先检查模型能力或附件数量限制。');
          }
        } catch (error) {
          if (attachments.length) await discardUncommittedAttachments(attachments);
          throw error;
        }
        incomingShare.clear(snapshot);
        projectChat.showNotice('分享内容已加入当前对话输入框，不会自动发送。');
        return;
      }

      const content = shareText(snapshot);
      if (!content) throw new Error('这份分享没有可保存的文本或链接。');
      const title = shareTitle(snapshot);
      if (destination === 'knowledge') {
        const result = await projectsNavigation.execute({ type: 'knowledge.create', title, content });
        if (!result.ok) throw new Error(result.notice);
      } else {
        const created = await projectsNavigation.execute({ type: 'artifact.create', format: 'markdown' });
        if (!created.ok || !created.createdArtifactId) {
          throw new Error(created.ok ? '创建成果失败。' : created.notice);
        }
        const saved = await projectsNavigation.execute({
          type: 'artifact.save',
          artifactId: created.createdArtifactId,
          title,
          content,
        });
        if (!saved.ok) throw new Error(saved.notice);
        projectChat.openArtifact(created.createdArtifactId);
      }
      incomingShare.clear(snapshot);
      projectChat.showNotice(destination === 'knowledge' ? '分享内容已保存为项目资料。' : '分享内容已保存为成果。');
    } catch (error) {
      setShareError(error instanceof Error ? error.message : '保存分享内容失败，请重试。');
    } finally {
      setShareBusyDestination(null);
    }
  }

  return (
    <MobileShell style={styles.root}>
      <ChatPane settings={settings} onOpenSetup={() => setSetupOpen(true)} />
      <SettingsPane />
      <ProjectDrawer chat={projectChat} />
      <FirstRunSetupWizard
        visible={setupOpen && !settings.isOpen}
        onUseSample={projectChat.setComposerText}
        onOpenSettings={() => settings.open({ kind: 'providers' })}
        onClose={() => setSetupOpen(false)}
      />
      <IncomingShareSheet
        visible={incomingShare.hasIncomingShare}
        snapshot={incomingShare.snapshot}
        isResolving={incomingShare.isResolving}
        busyDestination={shareBusyDestination}
        error={shareError ?? incomingShare.error}
        onClose={() => incomingShare.clear()}
        onResolve={() => { void incomingShare.resolve(); }}
        onSelectDestination={commitIncomingShare}
      />
      <AppDialogHost />
    </MobileShell>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
