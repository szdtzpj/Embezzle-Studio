import type {
  ChatMessage,
  WorkspaceArtifact,
  WorkspaceArtifactFormat,
  WorkspaceArtifactRevision,
} from '../domain/types';

export type { WorkspaceArtifact, WorkspaceArtifactFormat, WorkspaceArtifactRevision } from '../domain/types';

export const MAX_WORKSPACE_ARTIFACTS = 200;
export const MAX_WORKSPACE_ARTIFACT_REVISIONS = 50;
export const MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH = 500_000;
export const MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES = 2_000_000;
export const MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH = 120;
export const MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH = 40;
export const MAX_WORKSPACE_ARTIFACT_DIFF_LINES = 300;
export const MAX_WORKSPACE_ARTIFACT_DIFF_ENTRIES = 120;
export const MAX_WORKSPACE_ARTIFACT_DIFF_LINE_LENGTH = 240;

const WORKSPACE_ARTIFACT_FORMATS: readonly WorkspaceArtifactFormat[] = [
  'markdown',
  'plain-text',
  'code',
  'json',
  'html',
];

export interface WorkspaceArtifactIdentity {
  artifactId: string;
  revisionId: string;
  now: number;
}

export interface WorkspaceArtifactRevisionIdentity {
  revisionId: string;
  now: number;
}

export interface BlankWorkspaceArtifactInput {
  projectId: string;
  title: string;
  format: WorkspaceArtifactFormat;
  language?: string;
  content?: string;
}

export interface MessageWorkspaceArtifactInput {
  projectId: string;
  sourceConversationId: string;
  message: ChatMessage;
  title?: string;
  format?: WorkspaceArtifactFormat;
  language?: string;
}

export interface WorkspaceArtifactRevisionInput {
  content: string;
  author: WorkspaceArtifactRevision['author'];
  sourceMessageId?: string;
}

export interface WorkspaceArtifactLineDiffEntry {
  kind: 'added' | 'removed';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  lineTruncated: boolean;
}

export interface WorkspaceArtifactLineDiffSummary {
  beforeLineCount: number;
  afterLineCount: number;
  comparedBeforeLineCount: number;
  comparedAfterLineCount: number;
  addedLines: number;
  removedLines: number;
  unchangedLines: number;
  entries: WorkspaceArtifactLineDiffEntry[];
  truncated: boolean;
}

export interface WorkspaceArtifactLineDiffOptions {
  maxLines?: number;
  maxEntries?: number;
  maxLineLength?: number;
}

function characterLengthExceeds(value: string, limit: number): boolean {
  let length = 0;
  for (const character of value) {
    length += character.length > 0 ? 1 : 0;
    if (length > limit) return true;
  }
  return false;
}

function characterSlice(value: string, limit: number): string {
  if (limit <= 0) return '';
  let result = '';
  let length = 0;
  for (const character of value) {
    if (length >= limit) break;
    result += character;
    length += 1;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
}

export function workspaceArtifactContentBytes(
  artifacts: readonly WorkspaceArtifact[]
): number {
  return artifacts.reduce(
    (total, artifact) => total + artifact.revisions.reduce(
      (revisionTotal, revision) => revisionTotal + utf8ByteLength(revision.content),
      0
    ),
    0
  );
}

function assertWorkspaceArtifactBudget(artifacts: readonly WorkspaceArtifact[]): void {
  if (workspaceArtifactContentBytes(artifacts) > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) {
    throw new Error(
      `成果全部版本合计不能超过 ${MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES.toLocaleString()} UTF-8 字节；请删除旧成果或缩短内容。`
    );
  }
}

function validatedId(value: string, label: string): string {
  const id = value.trim();
  if (!id) {
    throw new Error(`${label}不能为空。`);
  }
  return id;
}

function validatedTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('成果时间戳必须是非负有限数字。');
  }
  return value;
}

/** Validates and trims a user-visible title without interpreting it as markup. */
export function validateWorkspaceArtifactTitle(value: string): string {
  const title = value.trim();
  if (!title) {
    throw new Error('成果标题不能为空。');
  }
  if (/\p{Cc}/u.test(title)) {
    throw new Error('成果标题不能包含控制字符。');
  }
  if (characterLengthExceeds(title, MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH)) {
    throw new Error(`成果标题不能超过 ${MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH} 个字符。`);
  }
  return title;
}

/** Accepts only the closed set rendered by the local artifact viewer. */
export function validateWorkspaceArtifactFormat(
  value: WorkspaceArtifactFormat | string
): WorkspaceArtifactFormat {
  if ((WORKSPACE_ARTIFACT_FORMATS as readonly string[]).includes(value)) {
    return value as WorkspaceArtifactFormat;
  }
  throw new Error('不支持的成果格式。');
}

/**
 * Keeps syntax labels inert and portable. A language is metadata only; it is
 * never interpolated into HTML, a command, or a module loader by this service.
 */
export function validateWorkspaceArtifactLanguage(
  value: string | null | undefined
): string | undefined {
  if (value === null || value === undefined || !value.trim()) {
    return undefined;
  }
  const language = value.trim();
  if (characterLengthExceeds(language, MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH)) {
    throw new Error(`成果语言不能超过 ${MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH} 个字符。`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9+.#_ -]*$/.test(language)) {
    throw new Error('成果语言只能包含安全的字母、数字、空格及 + . # _ -。');
  }
  return language;
}

function validatedContent(value: string): string {
  if (characterLengthExceeds(value, MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH)) {
    throw new Error(`单个成果版本不能超过 ${MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH} 个字符。`);
  }
  return value;
}

function validatedOptionalId(value: string | null | undefined, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return validatedId(value, label);
}

function requireArtifact(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string
): WorkspaceArtifact {
  const normalizedId = validatedId(artifactId, '成果 ID');
  const artifact = artifacts.find((candidate) => candidate.id === normalizedId);
  if (!artifact) {
    throw new Error('找不到要操作的成果。');
  }
  return artifact;
}

function ensureUniqueArtifactId(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string
): void {
  if (artifacts.some((artifact) => artifact.id === artifactId)) {
    throw new Error('成果 ID 已存在。');
  }
}

function ensureUniqueRevisionId(
  artifacts: readonly WorkspaceArtifact[],
  revisionId: string
): void {
  if (
    artifacts.some((artifact) =>
      artifact.revisions.some((revision) => revision.id === revisionId)
    )
  ) {
    throw new Error('成果版本 ID 已存在。');
  }
}

function cloneRevision(revision: WorkspaceArtifactRevision): WorkspaceArtifactRevision {
  return { ...revision };
}

function cloneArtifact(artifact: WorkspaceArtifact): WorkspaceArtifact {
  return {
    ...artifact,
    revisions: artifact.revisions.map(cloneRevision),
  };
}

/** Returns a stable local ordering without mutating the caller's collection. */
export function sortWorkspaceArtifacts(
  artifacts: readonly WorkspaceArtifact[]
): WorkspaceArtifact[] {
  return [...artifacts].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
  );
}

function trimRevisions(
  revisions: readonly WorkspaceArtifactRevision[],
  protectedRevisionIds: ReadonlySet<string>
): WorkspaceArtifactRevision[] {
  if (revisions.length <= MAX_WORKSPACE_ARTIFACT_REVISIONS) {
    return revisions.map(cloneRevision);
  }
  let removeCount = revisions.length - MAX_WORKSPACE_ARTIFACT_REVISIONS;
  const kept = revisions.filter((revision) => {
    if (removeCount > 0 && !protectedRevisionIds.has(revision.id)) {
      removeCount -= 1;
      return false;
    }
    return true;
  });

  // This only applies to malformed imported data with more protected revisions
  // than the supported total. Always retain the newest protected/current entry.
  if (kept.length > MAX_WORKSPACE_ARTIFACT_REVISIONS) {
    return kept.slice(kept.length - MAX_WORKSPACE_ARTIFACT_REVISIONS).map(cloneRevision);
  }
  return kept.map(cloneRevision);
}

function makeRevision(
  input: WorkspaceArtifactRevisionInput,
  metadata: WorkspaceArtifactRevisionIdentity
): WorkspaceArtifactRevision {
  const sourceMessageId = validatedOptionalId(input.sourceMessageId, '来源消息 ID');
  return {
    id: validatedId(metadata.revisionId, '成果版本 ID'),
    content: validatedContent(input.content),
    createdAt: validatedTimestamp(metadata.now),
    author: input.author,
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

function makeArtifact(
  artifacts: readonly WorkspaceArtifact[],
  input: BlankWorkspaceArtifactInput,
  metadata: WorkspaceArtifactIdentity,
  lineage?: { sourceConversationId: string; sourceMessageId: string; author: 'user' | 'assistant' }
): WorkspaceArtifact[] {
  if (artifacts.length >= MAX_WORKSPACE_ARTIFACTS) {
    throw new Error(`工作区最多保存 ${MAX_WORKSPACE_ARTIFACTS} 个成果。`);
  }
  const artifactId = validatedId(metadata.artifactId, '成果 ID');
  const revisionId = validatedId(metadata.revisionId, '成果版本 ID');
  ensureUniqueArtifactId(artifacts, artifactId);
  ensureUniqueRevisionId(artifacts, revisionId);
  const now = validatedTimestamp(metadata.now);
  const sourceConversationId = lineage
    ? validatedId(lineage.sourceConversationId, '来源对话 ID')
    : undefined;
  const sourceMessageId = lineage
    ? validatedId(lineage.sourceMessageId, '来源消息 ID')
    : undefined;
  const revision = makeRevision(
    {
      content: input.content ?? '',
      author: lineage?.author ?? 'user',
      ...(sourceMessageId ? { sourceMessageId } : {}),
    },
    { revisionId, now }
  );
  const language = validateWorkspaceArtifactLanguage(input.language);
  const artifact: WorkspaceArtifact = {
    id: artifactId,
    projectId: validatedId(input.projectId, '项目 ID'),
    title: validateWorkspaceArtifactTitle(input.title),
    format: validateWorkspaceArtifactFormat(input.format),
    ...(language ? { language } : {}),
    revisions: [revision],
    activeRevisionId: revision.id,
    ...(sourceConversationId ? { sourceConversationId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const next = sortWorkspaceArtifacts([...artifacts, artifact]);
  assertWorkspaceArtifactBudget(next);
  return next;
}

/** Creates an empty editable artifact with one local user revision. */
export function createBlankWorkspaceArtifact(
  artifacts: readonly WorkspaceArtifact[],
  input: BlankWorkspaceArtifactInput,
  metadata: WorkspaceArtifactIdentity
): WorkspaceArtifact[] {
  return makeArtifact(artifacts, input, metadata);
}

function derivedMessageTitle(message: ChatMessage): string {
  const firstMeaningfulLine = message.content
    .split(/\r?\n/, 12)
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}|[-*>])\s+/, '').trim())
    .find(Boolean);
  const fallback = message.role === 'assistant' ? '模型回答' : '用户消息';
  return characterSlice(firstMeaningfulLine || fallback, MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH);
}

/**
 * Copies a completed text message into a local artifact. The message content is
 * retained verbatim and remains inert even when the selected format is HTML.
 */
export function createWorkspaceArtifactFromMessage(
  artifacts: readonly WorkspaceArtifact[],
  input: MessageWorkspaceArtifactInput,
  metadata: WorkspaceArtifactIdentity
): WorkspaceArtifact[] {
  const { message } = input;
  if (message.status !== 'ready') {
    throw new Error('只能从已完成的消息创建成果。');
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error('系统消息不能创建为成果。');
  }
  if (!message.content) {
    throw new Error('空消息不能创建为成果。');
  }
  return makeArtifact(
    artifacts,
    {
      projectId: input.projectId,
      title: input.title ?? derivedMessageTitle(message),
      format: input.format ?? 'markdown',
      language: input.language,
      content: message.content,
    },
    metadata,
    {
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: message.id,
      author: message.role,
    }
  );
}

/** Renames one artifact while preserving all revision data. */
export function renameWorkspaceArtifact(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  title: string,
  now: number
): WorkspaceArtifact[] {
  const current = requireArtifact(artifacts, artifactId);
  const updated: WorkspaceArtifact = {
    ...current,
    title: validateWorkspaceArtifactTitle(title),
    revisions: current.revisions.map(cloneRevision),
    updatedAt: validatedTimestamp(now),
  };
  const next = sortWorkspaceArtifacts(
    artifacts.map((artifact) => (artifact.id === current.id ? updated : artifact))
  );
  assertWorkspaceArtifactBudget(next);
  return next;
}

/** Appends a bounded immutable revision and makes it active. */
export function appendWorkspaceArtifactRevision(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  input: WorkspaceArtifactRevisionInput,
  metadata: WorkspaceArtifactRevisionIdentity
): WorkspaceArtifact[] {
  const current = requireArtifact(artifacts, artifactId);
  const revisionId = validatedId(metadata.revisionId, '成果版本 ID');
  ensureUniqueRevisionId(artifacts, revisionId);
  const revision = makeRevision(input, { ...metadata, revisionId });
  const protectedIds = new Set([current.activeRevisionId, revision.id]);
  const updated: WorkspaceArtifact = {
    ...current,
    revisions: trimRevisions([...current.revisions, revision], protectedIds),
    activeRevisionId: revision.id,
    updatedAt: revision.createdAt,
  };
  const next = sortWorkspaceArtifacts(
    artifacts.map((artifact) => (artifact.id === current.id ? updated : artifact))
  );
  assertWorkspaceArtifactBudget(next);
  return next;
}

export function appendUserWorkspaceArtifactRevision(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  content: string,
  metadata: WorkspaceArtifactRevisionIdentity
): WorkspaceArtifact[] {
  return appendWorkspaceArtifactRevision(
    artifacts,
    artifactId,
    { content, author: 'user' },
    metadata
  );
}

export function appendAssistantWorkspaceArtifactRevision(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  content: string,
  sourceMessageId: string,
  metadata: WorkspaceArtifactRevisionIdentity
): WorkspaceArtifact[] {
  return appendWorkspaceArtifactRevision(
    artifacts,
    artifactId,
    { content, author: 'assistant', sourceMessageId },
    metadata
  );
}

/**
 * Restores old content by appending a new user revision. Existing history is
 * never rewritten, and no executable restore metadata is introduced.
 */
export function restoreWorkspaceArtifactRevision(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  revisionIdToRestore: string,
  metadata: WorkspaceArtifactRevisionIdentity
): WorkspaceArtifact[] {
  const artifact = requireArtifact(artifacts, artifactId);
  const sourceRevision = artifact.revisions.find(
    (revision) => revision.id === validatedId(revisionIdToRestore, '待恢复版本 ID')
  );
  if (!sourceRevision) {
    throw new Error('找不到要恢复的成果版本。');
  }
  return appendUserWorkspaceArtifactRevision(
    artifacts,
    artifact.id,
    sourceRevision.content,
    metadata
  );
}

/** Deletes one artifact only; its project and source conversation are untouched. */
export function deleteWorkspaceArtifact(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string
): WorkspaceArtifact[] {
  const current = requireArtifact(artifacts, artifactId);
  return artifacts.filter((artifact) => artifact.id !== current.id);
}

/** Returns detached artifact copies for one project in stable recency order. */
export function listWorkspaceArtifactsByProject(
  artifacts: readonly WorkspaceArtifact[],
  projectId: string
): WorkspaceArtifact[] {
  const normalizedProjectId = validatedId(projectId, '项目 ID');
  return sortWorkspaceArtifacts(
    artifacts
      .filter((artifact) => artifact.projectId === normalizedProjectId)
      .map(cloneArtifact)
  );
}

/** Moves one artifact between local projects without altering its revision history. */
export function moveWorkspaceArtifactToProject(
  artifacts: readonly WorkspaceArtifact[],
  artifactId: string,
  projectId: string,
  now: number
): WorkspaceArtifact[] {
  const current = requireArtifact(artifacts, artifactId);
  const updated: WorkspaceArtifact = {
    ...current,
    projectId: validatedId(projectId, '目标项目 ID'),
    revisions: current.revisions.map(cloneRevision),
    updatedAt: validatedTimestamp(now),
  };
  return sortWorkspaceArtifacts(
    artifacts.map((artifact) => (artifact.id === current.id ? updated : artifact))
  );
}

/** Migrates every artifact when a project is deleted, without deleting content. */
export function migrateWorkspaceArtifactsProject(
  artifacts: readonly WorkspaceArtifact[],
  fromProjectId: string,
  toProjectId: string,
  now: number
): WorkspaceArtifact[] {
  const from = validatedId(fromProjectId, '来源项目 ID');
  const to = validatedId(toProjectId, '目标项目 ID');
  const migratedAt = validatedTimestamp(now);
  if (from === to) {
    throw new Error('成果迁移的来源项目和目标项目不能相同。');
  }
  return sortWorkspaceArtifacts(
    artifacts.map((artifact) =>
      artifact.projectId === from
        ? {
            ...artifact,
            projectId: to,
            revisions: artifact.revisions.map(cloneRevision),
            updatedAt: migratedAt,
          }
        : artifact
    )
  );
}

/** Resolves the active revision as a detached value; invalid imported pointers fail closed. */
export function getActiveWorkspaceArtifactRevision(
  artifact: WorkspaceArtifact | null | undefined
): WorkspaceArtifactRevision | undefined {
  const revision = artifact?.revisions.find(
    (candidate) => candidate.id === artifact.activeRevisionId
  );
  return revision ? cloneRevision(revision) : undefined;
}

interface BoundedLines {
  lines: string[];
  total: number;
  truncated: boolean;
}

function collectBoundedLines(value: string, limit: number): BoundedLines {
  if (!value) return { lines: [], total: 0, truncated: false };
  const lines: string[] = [];
  let start = 0;
  let total = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== '\n') continue;
    total += 1;
    if (lines.length < limit) {
      const end = index > start && value[index - 1] === '\r' ? index - 1 : index;
      lines.push(value.slice(start, end));
    }
    start = index + 1;
  }
  return { lines, total, truncated: total > limit };
}

function validatedDiffLimit(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  label: string
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > hardMaximum) {
    throw new Error(`${label}必须是 1 到 ${hardMaximum} 之间的整数。`);
  }
  return result;
}

function previewLine(value: string, limit: number): { text: string; truncated: boolean } {
  if (!characterLengthExceeds(value, limit)) {
    return { text: value, truncated: false };
  }
  return { text: `${characterSlice(value, Math.max(1, limit - 1))}…`, truncated: true };
}

/**
 * Produces a deterministic line-level preview with strict time/memory bounds.
 * Only a bounded prefix is compared with LCS; large inputs are explicitly
 * marked truncated instead of allocating an unbounded quadratic matrix.
 */
export function summarizeWorkspaceArtifactLineDiff(
  before: string,
  after: string,
  options: WorkspaceArtifactLineDiffOptions = {}
): WorkspaceArtifactLineDiffSummary {
  validatedContent(before);
  validatedContent(after);
  const maxLines = validatedDiffLimit(
    options.maxLines,
    MAX_WORKSPACE_ARTIFACT_DIFF_LINES,
    MAX_WORKSPACE_ARTIFACT_DIFF_LINES,
    'Diff 行数上限'
  );
  const maxEntries = validatedDiffLimit(
    options.maxEntries,
    MAX_WORKSPACE_ARTIFACT_DIFF_ENTRIES,
    MAX_WORKSPACE_ARTIFACT_DIFF_ENTRIES,
    'Diff 条目上限'
  );
  const maxLineLength = validatedDiffLimit(
    options.maxLineLength,
    MAX_WORKSPACE_ARTIFACT_DIFF_LINE_LENGTH,
    MAX_WORKSPACE_ARTIFACT_DIFF_LINE_LENGTH,
    'Diff 单行预览上限'
  );
  const oldLines = collectBoundedLines(before, maxLines);
  const newLines = collectBoundedLines(after, maxLines);
  const width = newLines.lines.length + 1;
  const lcs = new Uint16Array((oldLines.lines.length + 1) * width);

  for (let oldIndex = oldLines.lines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.lines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      lcs[index] = oldLines.lines[oldIndex] === newLines.lines[newIndex]
        ? lcs[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(lcs[(oldIndex + 1) * width + newIndex], lcs[index + 1]);
    }
  }

  const entries: WorkspaceArtifactLineDiffEntry[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let addedLines = 0;
  let removedLines = 0;
  let unchangedLines = 0;
  let omittedEntries = false;
  let truncatedLine = false;

  const addEntry = (
    kind: WorkspaceArtifactLineDiffEntry['kind'],
    text: string,
    oldLineNumber?: number,
    newLineNumber?: number
  ) => {
    if (entries.length >= maxEntries) {
      omittedEntries = true;
      return;
    }
    const preview = previewLine(text, maxLineLength);
    truncatedLine ||= preview.truncated;
    entries.push({
      kind,
      text: preview.text,
      ...(oldLineNumber !== undefined ? { oldLineNumber } : {}),
      ...(newLineNumber !== undefined ? { newLineNumber } : {}),
      lineTruncated: preview.truncated,
    });
  };

  while (oldIndex < oldLines.lines.length || newIndex < newLines.lines.length) {
    if (
      oldIndex < oldLines.lines.length &&
      newIndex < newLines.lines.length &&
      oldLines.lines[oldIndex] === newLines.lines[newIndex]
    ) {
      unchangedLines += 1;
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const removeScore = oldIndex < oldLines.lines.length
      ? lcs[(oldIndex + 1) * width + newIndex]
      : -1;
    const addScore = newIndex < newLines.lines.length
      ? lcs[oldIndex * width + newIndex + 1]
      : -1;
    // Removal wins ties so identical input always produces identical ordering.
    if (oldIndex < oldLines.lines.length && removeScore >= addScore) {
      removedLines += 1;
      addEntry('removed', oldLines.lines[oldIndex], oldIndex + 1, undefined);
      oldIndex += 1;
    } else {
      addedLines += 1;
      addEntry('added', newLines.lines[newIndex], undefined, newIndex + 1);
      newIndex += 1;
    }
  }

  return {
    beforeLineCount: oldLines.total,
    afterLineCount: newLines.total,
    comparedBeforeLineCount: oldLines.lines.length,
    comparedAfterLineCount: newLines.lines.length,
    addedLines,
    removedLines,
    unchangedLines,
    entries,
    truncated:
      oldLines.truncated || newLines.truncated || omittedEntries || truncatedLine,
  };
}

/** Compares two stored revisions without exposing mutable revision references. */
export function summarizeWorkspaceArtifactRevisionDiff(
  artifact: WorkspaceArtifact,
  beforeRevisionId: string,
  afterRevisionId: string,
  options: WorkspaceArtifactLineDiffOptions = {}
): WorkspaceArtifactLineDiffSummary {
  const before = artifact.revisions.find(
    (revision) => revision.id === validatedId(beforeRevisionId, '旧版本 ID')
  );
  const after = artifact.revisions.find(
    (revision) => revision.id === validatedId(afterRevisionId, '新版本 ID')
  );
  if (!before || !after) {
    throw new Error('找不到要比较的成果版本。');
  }
  return summarizeWorkspaceArtifactLineDiff(before.content, after.content, options);
}
