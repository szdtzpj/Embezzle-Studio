import type {
  ChatConversation,
  ModelTargetRef,
  ProviderProfile,
  WorkspaceProject,
} from '../domain/types';
import { unicodeCharacterLength } from './textBounds';
import { isLegacyWorkspaceId } from './workspaceEntityIds';

export type { WorkspaceProject } from '../domain/types';

export const MAX_WORKSPACE_PROJECTS = 50;
export const MAX_WORKSPACE_PROJECT_NAME_LENGTH = 60;
export const MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH = 20_000;

export interface WorkspaceProjectInput {
  name: string;
  systemPrompt?: string;
  defaultTarget?: ModelTargetRef;
}

export interface WorkspaceProjectUpdate {
  name?: string;
  systemPrompt?: string | null;
  defaultTarget?: ModelTargetRef | null;
}

export interface DeletedWorkspaceProject {
  projects: WorkspaceProject[];
  conversations: ChatConversation[];
  fallbackProjectId: string;
}

function requireFiniteTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('项目时间戳必须是非负有限数字。');
  }
  return value;
}

function validatedProjectId(value: string): string {
  const id = value.trim();
  if (!isLegacyWorkspaceId(id)) {
    throw new Error('项目 ID 必须为 1-256 个字符，只能包含字母、数字、点、横线和下划线。');
  }
  return id;
}

function validatedProjectName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error('项目名称不能为空。');
  }
  if (unicodeCharacterLength(name) > MAX_WORKSPACE_PROJECT_NAME_LENGTH) {
    throw new Error(`项目名称不能超过 ${MAX_WORKSPACE_PROJECT_NAME_LENGTH} 个字符。`);
  }
  return name;
}

function normalizedSystemPrompt(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || !value.trim()) {
    return undefined;
  }
  if (unicodeCharacterLength(value) > MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH) {
    throw new Error(`项目系统提示不能超过 ${MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH} 个字符。`);
  }
  return value;
}

function normalizedTarget(value: ModelTargetRef | null | undefined): ModelTargetRef | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const providerId = value.providerId.trim();
  const modelId = value.modelId.trim();
  if (!providerId || !modelId) {
    throw new Error('项目默认模型必须同时包含服务商和模型 ID。');
  }
  return { providerId, modelId };
}

function requireProject(
  projects: readonly WorkspaceProject[],
  projectId: string
): WorkspaceProject {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error('找不到要操作的项目。');
  }
  return project;
}

/** Returns a stable local ordering without mutating the caller's collection. */
export function sortWorkspaceProjects(
  projects: readonly WorkspaceProject[]
): WorkspaceProject[] {
  return [...projects].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  );
}

/** Creates a project using only caller-supplied local identity and time metadata. */
export function createWorkspaceProject(
  projects: readonly WorkspaceProject[],
  input: WorkspaceProjectInput,
  metadata: { id: string; now: number }
): WorkspaceProject[] {
  if (projects.length >= MAX_WORKSPACE_PROJECTS) {
    throw new Error(`项目最多保存 ${MAX_WORKSPACE_PROJECTS} 个。`);
  }
  const id = validatedProjectId(metadata.id);
  if (projects.some((project) => project.id === id)) {
    throw new Error('项目 ID 已存在。');
  }
  const now = requireFiniteTimestamp(metadata.now);
  const systemPrompt = normalizedSystemPrompt(input.systemPrompt);
  const defaultTarget = normalizedTarget(input.defaultTarget);
  const project: WorkspaceProject = {
    id,
    name: validatedProjectName(input.name),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(defaultTarget !== undefined ? { defaultTarget } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return sortWorkspaceProjects([...projects, project]);
}

/** Updates editable project metadata while preserving identity and creation time. */
export function updateWorkspaceProject(
  projects: readonly WorkspaceProject[],
  projectId: string,
  update: WorkspaceProjectUpdate,
  now: number
): WorkspaceProject[] {
  const current = requireProject(projects, projectId);
  const next: WorkspaceProject = {
    ...current,
    ...(update.name !== undefined ? { name: validatedProjectName(update.name) } : {}),
    updatedAt: requireFiniteTimestamp(now),
  };
  if (update.systemPrompt !== undefined) {
    const prompt = normalizedSystemPrompt(update.systemPrompt);
    if (prompt === undefined) delete next.systemPrompt;
    else next.systemPrompt = prompt;
  }
  if (update.defaultTarget !== undefined) {
    const target = normalizedTarget(update.defaultTarget);
    if (target === undefined) delete next.defaultTarget;
    else next.defaultTarget = target;
  }
  return sortWorkspaceProjects(
    projects.map((project) => (project.id === current.id ? next : project))
  );
}

/** Moves one conversation between local projects without changing its chat recency. */
export function moveConversationToProject(
  conversations: readonly ChatConversation[],
  conversationId: string,
  projectId: string,
  projects: readonly WorkspaceProject[]
): ChatConversation[] {
  requireProject(projects, projectId);
  if (!conversations.some((conversation) => conversation.id === conversationId)) {
    throw new Error('找不到要移动的对话。');
  }
  const moved = conversations.map((conversation) =>
    conversation.id === conversationId ? { ...conversation, projectId } : conversation
  );
  const byId = new Map(moved.map((conversation) => [conversation.id, conversation] as const));
  return moved.map((conversation) => {
    const parent = conversation.parentConversationId
      ? byId.get(conversation.parentConversationId)
      : undefined;
    if (!parent || parent.projectId === conversation.projectId) {
      return conversation;
    }
    const detached = { ...conversation };
    delete detached.parentConversationId;
    delete detached.branchPointMessageId;
    return detached;
  });
}

/**
 * Deletes only project metadata. Conversations are retained and moved to an
 * explicit fallback project, so this local operation can never cascade-delete chat data.
 */
export function deleteWorkspaceProject(
  projects: readonly WorkspaceProject[],
  conversations: readonly ChatConversation[],
  projectId: string,
  fallbackProjectId: string
): DeletedWorkspaceProject {
  requireProject(projects, projectId);
  requireProject(projects, fallbackProjectId);
  if (projects.length <= 1) {
    throw new Error('至少需要保留一个项目。');
  }
  if (projectId === fallbackProjectId) {
    throw new Error('不能把被删除项目本身作为回退项目。');
  }
  return {
    projects: sortWorkspaceProjects(projects.filter((project) => project.id !== projectId)),
    conversations: conversations.map((conversation) =>
      conversation.projectId === projectId
        ? { ...conversation, projectId: fallbackProjectId }
        : conversation
    ),
    fallbackProjectId,
  };
}

/** Resolves a stored project target only when it still exists in the user's providers. */
export function resolveProjectDefaultTarget(
  project: WorkspaceProject | null | undefined,
  providers: readonly ProviderProfile[]
): ModelTargetRef | undefined {
  const target = project?.defaultTarget;
  if (!target) {
    return undefined;
  }
  const provider = providers.find((candidate) => candidate.id === target.providerId);
  return provider?.models.some((model) => model.id === target.modelId)
    ? { ...target }
    : undefined;
}
