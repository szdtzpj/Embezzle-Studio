import type {
  ChatConversation,
  ChatMessage,
  PromptTemplate,
  WorkspaceProject,
} from '../domain/types';

export const MAX_WORKSPACE_SEARCH_QUERY_LENGTH = 200;
export const MAX_WORKSPACE_SEARCH_RESULTS = 100;
export const DEFAULT_WORKSPACE_SEARCH_RESULTS = 80;
// Keep synchronous, on-device search bounded enough for mid-range Android
// devices. The limits still cover roughly 100 conversations × 15 messages,
// while avoiding a worst-case multi-hundred-megabyte normalized string index.
export const MAX_WORKSPACE_SEARCH_DOCUMENTS = 1_500;
export const MAX_WORKSPACE_SEARCH_FIELD_LENGTH = 4_000;

export type WorkspaceSearchResultKind = 'project' | 'conversation' | 'message' | 'prompt-template';
export type WorkspaceSearchMatchedField =
  | 'title'
  | 'content'
  | 'reasoning'
  | 'attachment'
  | 'system-prompt';

export interface WorkspaceSearchSource {
  projects: readonly WorkspaceProject[];
  conversations: readonly ChatConversation[];
  promptTemplates: readonly PromptTemplate[];
}

interface WorkspaceSearchField {
  kind: WorkspaceSearchMatchedField;
  value: string;
  normalized: string;
  weight: number;
}

interface WorkspaceSearchDocument {
  id: string;
  kind: WorkspaceSearchResultKind;
  title: string;
  updatedAt: number;
  projectId?: string;
  conversationId?: string;
  messageId?: string;
  fields: WorkspaceSearchField[];
}

export interface WorkspaceSearchIndex {
  readonly documents: readonly WorkspaceSearchDocument[];
}

export interface WorkspaceSearchResult {
  id: string;
  kind: WorkspaceSearchResultKind;
  title: string;
  snippet: string;
  score: number;
  updatedAt: number;
  matchedField: WorkspaceSearchMatchedField;
  projectId?: string;
  conversationId?: string;
  messageId?: string;
}

function boundedCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function normalizeWorkspaceSearchQuery(query: string): string {
  return boundedCharacters(
    normalizedText(boundedCharacters(query, MAX_WORKSPACE_SEARCH_QUERY_LENGTH)),
    MAX_WORKSPACE_SEARCH_QUERY_LENGTH
  );
}

function field(
  kind: WorkspaceSearchMatchedField,
  rawValue: string | null | undefined,
  weight: number
): WorkspaceSearchField | undefined {
  if (!rawValue) return undefined;
  const value = boundedCharacters(rawValue, MAX_WORKSPACE_SEARCH_FIELD_LENGTH);
  const normalized = boundedCharacters(
    normalizedText(value),
    MAX_WORKSPACE_SEARCH_FIELD_LENGTH
  );
  return normalized ? { kind, value, normalized, weight } : undefined;
}

function fields(values: Array<WorkspaceSearchField | undefined>): WorkspaceSearchField[] {
  return values.filter((value): value is WorkspaceSearchField => value !== undefined);
}

function messageDocument(
  conversation: ChatConversation,
  message: ChatMessage
): WorkspaceSearchDocument | undefined {
  if (message.id === 'welcome') return undefined;
  const attachmentNames = message.attachments?.map((attachment) => attachment.name).join(' ') ?? '';
  const searchableFields = fields([
    field('content', message.content, 380),
    field('reasoning', message.reasoningContent, 250),
    field('attachment', attachmentNames, 300),
  ]);
  if (!searchableFields.length) return undefined;
  return {
    id: `message:${conversation.id}:${message.id}`,
    kind: 'message',
    title: conversation.title,
    updatedAt: message.createdAt,
    ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
    conversationId: conversation.id,
    messageId: message.id,
    fields: searchableFields,
  };
}

/**
 * Builds a bounded local index from explicit non-secret workspace collections.
 * Provider profiles, API keys, plugin authorization, and network endpoints are
 * deliberately absent from the accepted source and cannot enter the index.
 */
export function buildWorkspaceSearchIndex(source: WorkspaceSearchSource): WorkspaceSearchIndex {
  const documents: WorkspaceSearchDocument[] = [];
  const append = (document: WorkspaceSearchDocument | undefined) => {
    if (document && documents.length < MAX_WORKSPACE_SEARCH_DOCUMENTS) documents.push(document);
  };

  for (const project of source.projects) {
    if (documents.length >= MAX_WORKSPACE_SEARCH_DOCUMENTS) break;
    append({
      id: `project:${project.id}`,
      kind: 'project',
      title: project.name,
      updatedAt: project.updatedAt,
      projectId: project.id,
      fields: fields([
        field('title', project.name, 700),
        field('system-prompt', project.systemPrompt, 280),
      ]),
    });
  }

  for (const template of source.promptTemplates) {
    if (documents.length >= MAX_WORKSPACE_SEARCH_DOCUMENTS) break;
    append({
      id: `prompt-template:${template.id}`,
      kind: 'prompt-template',
      title: template.name,
      updatedAt: template.updatedAt,
      fields: fields([
        field('title', template.name, 700),
        field('content', template.content, 340),
      ]),
    });
  }

  const conversations = [...source.conversations].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  );
  for (const conversation of conversations) {
    if (documents.length >= MAX_WORKSPACE_SEARCH_DOCUMENTS) break;
    append({
      id: `conversation:${conversation.id}`,
      kind: 'conversation',
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      conversationId: conversation.id,
      fields: fields([field('title', conversation.title, 700)]),
    });
    const recentMessages = [...conversation.messages].sort(
      (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)
    );
    for (const message of recentMessages) {
      if (documents.length >= MAX_WORKSPACE_SEARCH_DOCUMENTS) break;
      append(messageDocument(conversation, message));
    }
  }

  return { documents };
}

function snippetFor(fieldValue: string, normalizedQuery: string): string {
  const normalizedValue = normalizedText(fieldValue);
  const matchIndex = Math.max(0, normalizedValue.indexOf(normalizedQuery));
  const radius = 70;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(fieldValue.length, matchIndex + normalizedQuery.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < fieldValue.length ? '…' : '';
  return `${prefix}${fieldValue.slice(start, end).trim()}${suffix}`;
}

function resultLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_WORKSPACE_SEARCH_RESULTS;
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(MAX_WORKSPACE_SEARCH_RESULTS, Math.floor(requested));
}

/** Runs literal, deterministic substring search without regex evaluation or network access. */
export function searchWorkspaceIndex(
  index: WorkspaceSearchIndex,
  query: string,
  options: { limit?: number } = {}
): WorkspaceSearchResult[] {
  const normalizedQuery = normalizeWorkspaceSearchQuery(query);
  const limit = resultLimit(options.limit);
  if (!normalizedQuery || limit === 0) return [];

  const results: WorkspaceSearchResult[] = [];
  for (const document of index.documents) {
    let bestField: WorkspaceSearchField | undefined;
    let bestScore = -1;
    for (const candidate of document.fields) {
      const position = candidate.normalized.indexOf(normalizedQuery);
      if (position < 0) continue;
      const exactBonus = candidate.normalized === normalizedQuery ? 500 : 0;
      const prefixBonus = position === 0 ? 180 : 0;
      const score = candidate.weight + exactBonus + prefixBonus;
      if (score > bestScore) {
        bestScore = score;
        bestField = candidate;
      }
    }
    if (!bestField) continue;
    results.push({
      id: document.id,
      kind: document.kind,
      title: document.title,
      snippet: snippetFor(bestField.value, normalizedQuery),
      score: bestScore,
      updatedAt: document.updatedAt,
      matchedField: bestField.kind,
      ...(document.projectId ? { projectId: document.projectId } : {}),
      ...(document.conversationId ? { conversationId: document.conversationId } : {}),
      ...(document.messageId ? { messageId: document.messageId } : {}),
    });
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt - left.updatedAt ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, limit);
}

export function searchWorkspace(
  source: WorkspaceSearchSource,
  query: string,
  options: { limit?: number } = {}
): WorkspaceSearchResult[] {
  return searchWorkspaceIndex(buildWorkspaceSearchIndex(source), query, options);
}
