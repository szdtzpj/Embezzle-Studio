import type { AppWorkspace, ChatConversation, MediaAttachment } from '../../../domain/types';
import {
  forkConversationAtMessage,
  removeConversationPreservingBranches,
} from '../../../services/conversationBranches';
import {
  createImportedTextProjectKnowledgeSource,
  createManualProjectKnowledgeSource,
  createProjectKnowledgeSourceFromArtifact,
  createProjectKnowledgeSourceFromMessage,
  deleteProjectKnowledgeSource,
  MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES,
  migrateProjectKnowledgeSources,
  updateProjectKnowledgeSource,
} from '../../../services/projectKnowledge';
import {
  appendUserWorkspaceArtifactRevision,
  createBlankWorkspaceArtifact,
  createWorkspaceArtifactFromMessage,
  deleteWorkspaceArtifact,
  getActiveWorkspaceArtifactRevision,
  migrateWorkspaceArtifactsProject,
  moveWorkspaceArtifactToProject,
  renameWorkspaceArtifact,
  restoreWorkspaceArtifactRevision,
} from '../../../services/workspaceArtifacts';
import {
  createWorkspaceProject,
  deleteWorkspaceProject,
  moveConversationToProject,
  resolveProjectDefaultTarget,
  updateWorkspaceProject,
} from '../../../services/workspaceProjects';
import {
  changesProjectConversationRequestContext,
  PROJECT_CONVERSATION_HISTORY_LOCK_NOTICE,
  type ProjectConversationCommand,
} from '../projectConversationCommands';
import type { ProjectConversationResult } from '../projectConversationResults';
import {
  clearWorkspaceSourceLineage,
  hasConversationHistory,
  MAX_SAVED_CONVERSATIONS,
  messageAttachments,
  projectInstructionMessage,
  sortConversations,
  syncProjectInstructionSnapshot,
} from '../projectConversationHelpers';
import { normalizeArtifactTags } from '../../../services/workspaceProductState';

export interface ProjectConversationReduceContext {
  now: number;
  createId: (prefix: string) => string;
  historyLocked: boolean;
}

export type ProjectConversationReduceOutput = {
  workspace: AppWorkspace;
  result: ProjectConversationResult;
};

function fail(notice: string, workspace: AppWorkspace): ProjectConversationReduceOutput {
  return { workspace, result: { ok: false, notice } };
}

function ok(
  workspace: AppWorkspace,
  result: Omit<Extract<ProjectConversationResult, { ok: true }>, 'ok'> = {}
): ProjectConversationReduceOutput {
  return { workspace, result: { ok: true, ...result } };
}

function activeChatContextChanged(before: AppWorkspace, after: AppWorkspace): boolean {
  return (
    before.activeProjectId !== after.activeProjectId ||
    before.activeConversationId !== after.activeConversationId ||
    before.activeProviderId !== after.activeProviderId ||
    before.activeModelIdByProvider[before.activeProviderId] !==
      after.activeModelIdByProvider[after.activeProviderId]
  );
}

/** Derive cross-feature Chat cleanup from the committed active-context change. */
function okAfterActiveContextChange(
  before: AppWorkspace,
  after: AppWorkspace,
  result: Omit<Extract<ProjectConversationResult, { ok: true }>, 'ok'> = {}
): ProjectConversationReduceOutput {
  return activeChatContextChanged(before, after)
    ? ok(after, { ...result, activeContextChanged: true, taskQueriesInvalidated: true })
    : ok(after, result);
}

/**
 * Pure project/conversation command reducer.
 * Feature runtime binds this to WorkspaceCommitPort; visual code never imports it.
 */
export function reduceProjectConversationCommand(
  workspace: AppWorkspace,
  command: ProjectConversationCommand,
  context: ProjectConversationReduceContext
): ProjectConversationReduceOutput {
  const { now, createId, historyLocked } = context;

  if (historyLocked && changesProjectConversationRequestContext(command)) {
    return fail(PROJECT_CONVERSATION_HISTORY_LOCK_NOTICE, workspace);
  }

  switch (command.type) {
    case 'project.create': {
      if (workspace.conversations.length >= MAX_SAVED_CONVERSATIONS) {
        return fail(
          `本机最多保存 ${MAX_SAVED_CONVERSATIONS} 个对话；请先导出备份并删除不需要的对话，再创建项目。`,
          workspace
        );
      }
      try {
        const id = createId('project');
        const projects = createWorkspaceProject(workspace.projects, command.input, { id, now });
        const project = projects.find((candidate) => candidate.id === id);
        if (!project) {
          return fail('项目创建后无法读取。', workspace);
        }
        const instruction = projectInstructionMessage(project, now, createId);
        const messages = instruction ? [instruction] : [];
        const conversation: ChatConversation = {
          id: createId('conversation'),
          title: '新对话',
          projectId: id,
          createdAt: now,
          updatedAt: now,
          messages,
        };
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            projects,
            activeProjectId: id,
            activeConversationId: conversation.id,
            conversations: sortConversations([conversation, ...workspace.conversations]),
            messages,
          },
          {
            notice:
              command.successNotice ??
              '项目已在本机创建；创建本身不会调用模型或产生费用。',
            activeContextChanged: true,
          }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : '项目创建失败。', workspace);
      }
    }

    case 'project.update': {
      try {
        const projects = updateWorkspaceProject(
          workspace.projects,
          command.projectId,
          command.patch,
          now
        );
        const savedProject = projects.find((project) => project.id === command.projectId);
        if (savedProject) {
          // Keep every empty conversation in the project aligned with the
          // latest instruction. Only the active empty chat was refreshed
          // before, so another empty chat could later expose a stale snapshot.
          const refreshedIds = new Set(
            workspace.conversations
              .filter(
                (candidate) =>
                  candidate.projectId === command.projectId && !hasConversationHistory(candidate)
              )
              .map((candidate) => candidate.id)
          );
          const conversations = workspace.conversations.map((candidate) => {
            if (!refreshedIds.has(candidate.id)) return candidate;
            return {
              ...candidate,
              messages: syncProjectInstructionSnapshot(
                candidate.messages,
                savedProject,
                now,
                createId
              ),
              updatedAt: now,
            };
          });
          const activeConversation = conversations.find(
            (candidate) => candidate.id === workspace.activeConversationId
          );
          return ok(
            {
              ...workspace,
              projects,
              conversations,
              ...(activeConversation && refreshedIds.has(activeConversation.id)
                ? { messages: activeConversation.messages }
                : {}),
            },
            {
              notice:
                '项目设置已保存在本机；系统提示只会随你之后主动发送的请求交给服务商。',
            }
          );
        }
        return fail('找不到要保存的项目。', workspace);
      } catch (error) {
        return fail(error instanceof Error ? error.message : '项目保存失败。', workspace);
      }
    }

    case 'project.setDefaultTarget': {
      try {
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            projects: updateWorkspaceProject(
              workspace.projects,
              command.projectId,
              {
                defaultTarget: {
                  providerId: command.providerId,
                  modelId: command.modelId,
                },
              },
              now
            ),
          },
          { notice: '已将当前模型设为这个项目的新对话默认模型。' }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : '项目默认模型设置失败。', workspace);
      }
    }

    case 'project.delete': {
      try {
        const targetProject = workspace.projects.find(
          (project) => project.id === command.projectId
        );
        const fallback = workspace.projects.find(
          (project) => project.id === command.fallbackProjectId
        );
        if (!targetProject || !fallback) {
          return fail('确认期间项目列表已变化，请重新操作。', workspace);
        }
        const migratedConversationIds = new Set(
          workspace.conversations
            .filter((conversation) => conversation.projectId === targetProject.id)
            .map((conversation) => conversation.id)
        );
        const result = deleteWorkspaceProject(
          workspace.projects,
          workspace.conversations,
          targetProject.id,
          fallback.id
        );
        const conversations = result.conversations.map((conversation) =>
          migratedConversationIds.has(conversation.id) && !hasConversationHistory(conversation)
            ? {
                ...conversation,
                messages: syncProjectInstructionSnapshot(
                  conversation.messages,
                  fallback,
                  now,
                  createId
                ),
                updatedAt: now,
              }
            : conversation
        );
        const activeConversation = conversations.find(
          (conversation) => conversation.id === workspace.activeConversationId
        );
        const fallbackDefaultTarget =
          activeConversation && !hasConversationHistory(activeConversation)
            ? resolveProjectDefaultTarget(fallback, workspace.providers)
            : undefined;
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            projects: result.projects,
            conversations,
            artifacts: migrateWorkspaceArtifactsProject(
              workspace.artifacts,
              targetProject.id,
              fallback.id,
              now
            ),
            knowledgeSources: migrateProjectKnowledgeSources(
              workspace.knowledgeSources,
              targetProject.id,
              fallback.id,
              now
            ),
            activeProjectId: activeConversation?.projectId ?? fallback.id,
            ...(activeConversation ? { messages: activeConversation.messages } : {}),
            ...(fallbackDefaultTarget
              ? {
                  activeProviderId: fallbackDefaultTarget.providerId,
                  activeModelIdByProvider: {
                    ...workspace.activeModelIdByProvider,
                    [fallbackDefaultTarget.providerId]: fallbackDefaultTarget.modelId,
                  },
                }
              : {}),
          },
          {
            notice: '项目已删除；其中的对话、成果和项目资料已完整移入回退项目。',
          }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : '项目删除失败。', workspace);
      }
    }

    case 'project.activate': {
      const conversation = sortConversations(
        workspace.conversations.filter((candidate) => candidate.projectId === command.projectId)
      )[0];
      if (!conversation) {
        return reduceProjectConversationCommand(
          workspace,
          {
            type: 'conversation.start',
            projectId: command.projectId,
            noticeText: '已进入项目并创建本地新对话。',
          },
          context
        );
      }
      const project = workspace.projects.find((candidate) => candidate.id === command.projectId);
      const activatedMessages =
        project && !hasConversationHistory(conversation)
          ? syncProjectInstructionSnapshot(conversation.messages, project, now, createId)
          : conversation.messages;
      const defaultTarget = !hasConversationHistory(conversation)
        ? resolveProjectDefaultTarget(project, workspace.providers)
        : undefined;
      return okAfterActiveContextChange(
        workspace,
        {
          ...workspace,
          activeProjectId: command.projectId,
          activeConversationId: conversation.id,
          messages: activatedMessages,
          conversations:
            activatedMessages === conversation.messages
              ? workspace.conversations
              : workspace.conversations.map((candidate) =>
                  candidate.id === conversation.id
                    ? { ...candidate, messages: activatedMessages, updatedAt: now }
                    : candidate
                ),
          ...(defaultTarget
            ? {
                activeProviderId: defaultTarget.providerId,
                activeModelIdByProvider: {
                  ...workspace.activeModelIdByProvider,
                  [defaultTarget.providerId]: defaultTarget.modelId,
                },
              }
            : {}),
        },
        {
          notice: '',
        }
      );
    }

    case 'conversation.start': {
      const projectId = command.projectId ?? workspace.activeProjectId;
      const project = workspace.projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return fail('找不到要使用的项目。', workspace);
      }
      const activeEmptyConversation = workspace.conversations.find(
        (conversation) =>
          conversation.id === workspace.activeConversationId &&
          conversation.projectId === projectId &&
          !hasConversationHistory(conversation)
      );
      if (activeEmptyConversation) {
        const messages = syncProjectInstructionSnapshot(
          activeEmptyConversation.messages,
          project,
          now,
          createId
        );
        const defaultTarget = resolveProjectDefaultTarget(project, workspace.providers);
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            messages,
            conversations: workspace.conversations.map((conversation) =>
              conversation.id === activeEmptyConversation.id
                ? { ...conversation, messages, updatedAt: now }
                : conversation
            ),
            ...(defaultTarget
              ? {
                  activeProviderId: defaultTarget.providerId,
                  activeModelIdByProvider: {
                    ...workspace.activeModelIdByProvider,
                    [defaultTarget.providerId]: defaultTarget.modelId,
                  },
                }
              : {}),
          },
          {
            notice: command.noticeText ?? '',
            activeContextChanged: true,
            taskQueriesInvalidated: true,
          }
        );
      }
      if (workspace.conversations.length >= MAX_SAVED_CONVERSATIONS) {
        return fail(
          `本机最多保存 ${MAX_SAVED_CONVERSATIONS} 个对话；请先导出备份并删除不需要的对话。`,
          workspace
        );
      }
      const conversationId = createId('conversation');
      const instruction = projectInstructionMessage(project, now, createId);
      const messages = instruction ? [instruction] : [];
      const defaultTarget = resolveProjectDefaultTarget(project, workspace.providers);
      const conversation: ChatConversation = {
        id: conversationId,
        title: '新对话',
        projectId,
        createdAt: now,
        updatedAt: now,
        messages,
      };
      return okAfterActiveContextChange(
        workspace,
        {
          ...workspace,
          activeProjectId: projectId,
          activeConversationId: conversationId,
          conversations: sortConversations([conversation, ...workspace.conversations]),
          messages,
          ...(defaultTarget
            ? {
                activeProviderId: defaultTarget.providerId,
                activeModelIdByProvider: {
                  ...workspace.activeModelIdByProvider,
                  [defaultTarget.providerId]: defaultTarget.modelId,
                },
              }
            : {}),
        },
        {
          notice: command.noticeText ?? '',
          activeContextChanged: true,
          taskQueriesInvalidated: true,
        }
      );
    }

    case 'conversation.activate': {
      const conversation = workspace.conversations.find(
        (item) => item.id === command.conversationId
      );
      if (!conversation) {
        return ok(workspace);
      }
      const project = workspace.projects.find(
        (candidate) => candidate.id === conversation.projectId
      );
      const activatedMessages =
        project && !hasConversationHistory(conversation)
          ? syncProjectInstructionSnapshot(conversation.messages, project, now, createId)
          : conversation.messages;
      const defaultTarget = !hasConversationHistory(conversation)
        ? resolveProjectDefaultTarget(project, workspace.providers)
        : undefined;
      return okAfterActiveContextChange(
        workspace,
        {
          ...workspace,
          activeProjectId: conversation.projectId ?? workspace.projects[0].id,
          activeConversationId: conversation.id,
          messages: activatedMessages,
          conversations:
            activatedMessages === conversation.messages
              ? workspace.conversations
              : workspace.conversations.map((candidate) =>
                  candidate.id === conversation.id
                    ? { ...candidate, messages: activatedMessages, updatedAt: now }
                    : candidate
                ),
          ...(defaultTarget
            ? {
                activeProviderId: defaultTarget.providerId,
                activeModelIdByProvider: {
                  ...workspace.activeModelIdByProvider,
                  [defaultTarget.providerId]: defaultTarget.modelId,
                },
              }
            : {}),
        },
        {
          notice: '',
        }
      );
    }

    case 'conversation.move': {
      try {
        const project = workspace.projects.find(
          (candidate) => candidate.id === command.projectId
        );
        const originalConversation = workspace.conversations.find(
          (conversation) => conversation.id === command.conversationId
        );
        const crossedProjectBoundary = Boolean(
          originalConversation && originalConversation.projectId !== command.projectId
        );
        let conversations = moveConversationToProject(
          workspace.conversations,
          command.conversationId,
          command.projectId,
          workspace.projects
        );
        if (crossedProjectBoundary) {
          conversations = conversations.map((conversation) => {
            if (
              conversation.id !== command.conversationId ||
              !conversation.knowledgeSourceIds?.length
            ) {
              return conversation;
            }
            const next = { ...conversation };
            delete next.knowledgeSourceIds;
            return next;
          });
        }
        const moved = conversations.find(
          (conversation) => conversation.id === command.conversationId
        );
        let defaultTarget: ReturnType<typeof resolveProjectDefaultTarget>;
        if (project && moved && !hasConversationHistory(moved)) {
          const messages = syncProjectInstructionSnapshot(
            moved.messages,
            project,
            now,
            createId
          );
          defaultTarget = resolveProjectDefaultTarget(project, workspace.providers);
          conversations = conversations.map((conversation) =>
            conversation.id === command.conversationId
              ? { ...conversation, messages, updatedAt: now }
              : conversation
          );
        }
        const activeConversation = conversations.find(
          (conversation) => conversation.id === workspace.activeConversationId
        );
        const lineage =
          crossedProjectBoundary && originalConversation
            ? clearWorkspaceSourceLineage(
                workspace.artifacts,
                workspace.knowledgeSources,
                new Set([originalConversation.id]),
                new Set(originalConversation.messages.map((message) => message.id))
              )
            : {
                artifacts: workspace.artifacts,
                knowledgeSources: workspace.knowledgeSources,
              };
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            ...lineage,
            conversations,
            ...(workspace.activeConversationId === command.conversationId
              ? {
                  activeProjectId: command.projectId,
                  messages: activeConversation?.messages ?? [],
                  ...(defaultTarget
                    ? {
                        activeProviderId: defaultTarget.providerId,
                        activeModelIdByProvider: {
                          ...workspace.activeModelIdByProvider,
                          [defaultTarget.providerId]: defaultTarget.modelId,
                        },
                      }
                    : {}),
                }
              : {}),
          },
          {
            notice: '对话已移动；跨项目的资料选择、分支关联和来源追踪已安全清理。',
          }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : '移动对话失败。', workspace);
      }
    }

    case 'conversation.fork': {
      if (workspace.conversations.length >= MAX_SAVED_CONVERSATIONS) {
        return fail(
          `本机最多保存 ${MAX_SAVED_CONVERSATIONS} 个对话，未创建分支。`,
          workspace
        );
      }
      try {
        const branch = forkConversationAtMessage(
          workspace.conversations,
          command.conversationId,
          command.messageId,
          {
            conversationId: createId('conversation'),
            now,
            createMessageId: () => createId('msg'),
            createComparisonGroupId: () => createId('compare'),
          }
        );
        return okAfterActiveContextChange(
          workspace,
          {
            ...workspace,
            activeProjectId: branch.projectId ?? workspace.activeProjectId,
            activeConversationId: branch.id,
            messages: branch.messages,
            conversations: sortConversations([branch, ...workspace.conversations]),
          },
          {
            notice:
              '已创建本地对话分支；复制历史不会重复计入用量统计，也不会发起模型请求。',
            activeContextChanged: true,
          }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : '创建对话分支失败。', workspace);
      }
    }

    case 'conversation.delete': {
      const deletedConversation = workspace.conversations.find(
        (conversation) => conversation.id === command.conversationId
      );
      const deletedDraft = workspace.composerDrafts.find(
        (draft) => draft.conversationId === command.conversationId
      );
      let orphanedAttachments: MediaAttachment[] | undefined;
      if (deletedConversation || deletedDraft) {
        const retainedUris = new Set(
          workspace.conversations
            .filter((conversation) => conversation.id !== command.conversationId)
            .flatMap((conversation) => messageAttachments(conversation.messages))
            .map((attachment) => attachment.uri)
        );
        for (const draft of workspace.composerDrafts) {
          if (draft.conversationId === command.conversationId) continue;
          for (const attachment of draft.attachments ?? []) retainedUris.add(attachment.uri);
        }
        orphanedAttachments = [
          ...(deletedConversation
            ? messageAttachments(deletedConversation.messages)
            : []),
          ...(deletedDraft?.attachments ?? []),
        ].filter((attachment, index, attachments) =>
          !retainedUris.has(attachment.uri) &&
          attachments.findIndex((candidate) => candidate.uri === attachment.uri) === index
        );
      }
      const deletingActiveConversation =
        workspace.activeConversationId === command.conversationId;
      const lineage = clearWorkspaceSourceLineage(
        workspace.artifacts,
        workspace.knowledgeSources,
        new Set(deletedConversation ? [deletedConversation.id] : []),
        new Set(deletedConversation?.messages.map((message) => message.id) ?? [])
      );
      const conversations = removeConversationPreservingBranches(
        workspace.conversations,
        command.conversationId
      );
      const nextActive = deletingActiveConversation
        ? sortConversations(
            conversations.filter(
              (conversation) => conversation.projectId === workspace.activeProjectId
            )
          )[0] ?? conversations[0]
        : conversations.find((item) => item.id === workspace.activeConversationId);

      return ok(
        {
          ...workspace,
          ...lineage,
          conversations,
          activeProjectId: nextActive?.projectId ?? workspace.projects[0].id,
          activeConversationId: nextActive?.id ?? 'conversation-default',
          composerDrafts: workspace.composerDrafts.filter(
            (draft) => draft.conversationId !== command.conversationId
          ),
          messages: deletingActiveConversation
            ? nextActive?.messages ?? []
            : workspace.messages,
        },
        {
          notice: '已从本地移除该聊天记录。',
          activeContextChanged: deletingActiveConversation,
          taskQueriesInvalidated: true,
          orphanedAttachments,
        }
      );
    }

    case 'conversation.rename': {
      const title = command.title.trim().replace(/\s+/g, ' ');
      if (!title) {
        return fail('对话名称不能为空。', workspace);
      }
      return ok(
        {
          ...workspace,
          conversations: sortConversations(
            workspace.conversations.map((conversation) =>
              conversation.id === command.conversationId
                ? {
                    ...conversation,
                    title,
                    customTitle: true,
                  }
                : conversation
            )
          ),
        },
        {
          notice: '已更新对话名称。',
        }
      );
    }

    case 'conversation.pin': {
      return ok(
        {
          ...workspace,
          conversations: sortConversations(
            workspace.conversations.map((conversation) => {
              if (conversation.id !== command.conversationId) {
                return conversation;
              }
              if (command.pinned) {
                return {
                  ...conversation,
                  pinnedAt: conversation.pinnedAt ?? now,
                };
              }
              if (!conversation.pinnedAt) {
                return conversation;
              }
              const { pinnedAt: _pinnedAt, ...rest } = conversation;
              return rest;
            })
          ),
        },
        {}
      );
    }

    case 'conversation.toggle-knowledge': {
      const conversation = workspace.conversations.find(
        (candidate) => candidate.id === workspace.activeConversationId
      );
      const projectId = conversation?.projectId ?? workspace.activeProjectId;
      const source = workspace.knowledgeSources.find(
        (candidate) => candidate.id === command.sourceId && candidate.projectId === projectId
      );
      if (!conversation || !source) return ok(workspace);
      const selected = new Set(conversation.knowledgeSourceIds ?? []);
      if (selected.has(command.sourceId)) selected.delete(command.sourceId);
      else if (selected.size < MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES) selected.add(command.sourceId);
      else {
        return fail(
          `每个会话最多显式选择 ${MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES} 条项目资料。`,
          workspace
        );
      }
      const knowledgeSourceIds = [...selected];
      return ok({
        ...workspace,
        conversations: workspace.conversations.map((candidate) => {
          if (candidate.id !== conversation.id) return candidate;
          const next = { ...candidate, updatedAt: now };
          if (knowledgeSourceIds.length) next.knowledgeSourceIds = knowledgeSourceIds;
          else delete next.knowledgeSourceIds;
          return next;
        }),
      });
    }

    case 'artifact.create': {
      const artifactId = createId('artifact');
      return ok(
        {
          ...workspace,
          artifacts: createBlankWorkspaceArtifact(
            workspace.artifacts,
            {
              projectId: workspace.activeProjectId,
              title: '未命名成果',
              format: command.format,
              content: '',
            },
            { artifactId, revisionId: createId('artifact-revision'), now }
          ),
        },
        { createdArtifactId: artifactId }
      );
    }

    case 'artifact.save': {
      const currentArtifact = workspace.artifacts.find(
        (artifact) => artifact.id === command.artifactId
      );
      if (!currentArtifact) return fail('找不到要保存的成果。', workspace);
      let artifacts = workspace.artifacts;
      if (command.title.trim() !== currentArtifact.title) {
        artifacts = renameWorkspaceArtifact(artifacts, command.artifactId, command.title, now);
      }
      const activeRevision = getActiveWorkspaceArtifactRevision(currentArtifact);
      if (!activeRevision || activeRevision.content !== command.content) {
        artifacts = appendUserWorkspaceArtifactRevision(
          artifacts,
          command.artifactId,
          command.content,
          { revisionId: createId('artifact-revision'), now }
        );
      }
      return ok({ ...workspace, artifacts });
    }

    case 'artifact.restore':
      return ok({
        ...workspace,
        artifacts: restoreWorkspaceArtifactRevision(
          workspace.artifacts,
          command.artifactId,
          command.sourceRevisionId,
          { revisionId: createId('artifact-revision'), now }
        ),
      });

    case 'artifact.set-favorite':
      return ok({
        ...workspace,
        artifacts: workspace.artifacts.map((artifact) =>
          artifact.id === command.artifactId
            ? {
                ...artifact,
                ...(command.favorite ? { favorite: true } : { favorite: undefined }),
                updatedAt: now,
              }
            : artifact
        ),
      });

    case 'artifact.set-tags': {
      const tags = normalizeArtifactTags(command.tags);
      return ok({
        ...workspace,
        artifacts: workspace.artifacts.map((artifact) =>
          artifact.id === command.artifactId
            ? { ...artifact, ...(tags ? { tags } : { tags: undefined }), updatedAt: now }
            : artifact
        ),
      });
    }

    case 'artifact.move':
      if (!workspace.projects.some((project) => project.id === command.projectId)) {
        return fail('找不到目标项目。', workspace);
      }
      return ok({
        ...workspace,
        artifacts: moveWorkspaceArtifactToProject(
          workspace.artifacts,
          command.artifactId,
          command.projectId,
          now
        ),
      });

    case 'artifact.delete':
      return ok({
        ...workspace,
        artifacts: deleteWorkspaceArtifact(workspace.artifacts, command.artifactId),
        knowledgeSources: workspace.knowledgeSources.map((source) => {
          if (source.sourceArtifactId !== command.artifactId) return source;
          const next = { ...source };
          delete next.sourceArtifactId;
          return next;
        }),
      });

    case 'artifact.to-knowledge': {
      const artifact = workspace.artifacts.find((candidate) => candidate.id === command.artifactId);
      if (!artifact) return fail('找不到要保存为资料的成果。', workspace);
      return ok({
        ...workspace,
        knowledgeSources: createProjectKnowledgeSourceFromArtifact(
          workspace.knowledgeSources,
          artifact,
          {},
          { id: createId('knowledge'), now }
        ),
      });
    }

    case 'artifact.from-message': {
      const conversationId = workspace.activeConversationId || 'conversation-default';
      const conversation = workspace.conversations.find(
        (candidate) => candidate.id === conversationId
      );
      const artifactId = createId('artifact');
      return ok(
        {
          ...workspace,
          artifacts: createWorkspaceArtifactFromMessage(
            workspace.artifacts,
            {
              projectId: conversation?.projectId ?? workspace.activeProjectId,
              sourceConversationId: conversationId,
              message: command.message,
              format: 'markdown',
            },
            { artifactId, revisionId: createId('artifact-revision'), now }
          ),
        },
        { createdArtifactId: artifactId }
      );
    }

    case 'knowledge.create':
      return ok({
        ...workspace,
        knowledgeSources: createManualProjectKnowledgeSource(
          workspace.knowledgeSources,
          { title: command.title, content: command.content },
          { id: createId('knowledge'), projectId: workspace.activeProjectId, now }
        ),
      });

    case 'knowledge.from-message': {
      const conversationId = workspace.activeConversationId || 'conversation-default';
      const conversation = workspace.conversations.find(
        (candidate) => candidate.id === conversationId
      );
      return ok({
        ...workspace,
        knowledgeSources: createProjectKnowledgeSourceFromMessage(
          workspace.knowledgeSources,
          command.message,
          { sourceConversationId: conversationId },
          {
            id: createId('knowledge'),
            projectId: conversation?.projectId ?? workspace.activeProjectId,
            now,
          }
        ),
      });
    }

    case 'knowledge.update':
      return ok({
        ...workspace,
        knowledgeSources: updateProjectKnowledgeSource(
          workspace.knowledgeSources,
          command.sourceId,
          { title: command.title, content: command.content },
          now
        ),
      });

    case 'knowledge.delete':
      return ok({
        ...workspace,
        knowledgeSources: deleteProjectKnowledgeSource(
          workspace.knowledgeSources,
          command.sourceId
        ),
        conversations: workspace.conversations.map((conversation) => {
          if (!conversation.knowledgeSourceIds?.includes(command.sourceId)) return conversation;
          const knowledgeSourceIds = conversation.knowledgeSourceIds.filter(
            (id) => id !== command.sourceId
          );
          const next = { ...conversation, updatedAt: now };
          if (knowledgeSourceIds.length) next.knowledgeSourceIds = knowledgeSourceIds;
          else delete next.knowledgeSourceIds;
          return next;
        }),
      });

    case 'knowledge.import':
      return ok({
        ...workspace,
        knowledgeSources: createImportedTextProjectKnowledgeSource(
          workspace.knowledgeSources,
          command.picked,
          { id: createId('knowledge'), projectId: workspace.activeProjectId, now }
        ),
      });

    default: {
      const _exhaustive: never = command;
      return fail(`未知项目/对话命令：${JSON.stringify(_exhaustive)}`, workspace);
    }
  }
}
