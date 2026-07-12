import { describe, expect, it } from 'vitest';

import type {
  ChatMessage,
  WorkspaceArtifact,
  WorkspaceArtifactRevision,
} from '../src/domain/types';
import {
  MAX_WORKSPACE_ARTIFACTS,
  MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH,
  MAX_WORKSPACE_ARTIFACT_REVISIONS,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
  appendAssistantWorkspaceArtifactRevision,
  appendUserWorkspaceArtifactRevision,
  appendWorkspaceArtifactRevision,
  createBlankWorkspaceArtifact,
  createWorkspaceArtifactFromMessage,
  deleteWorkspaceArtifact,
  getActiveWorkspaceArtifactRevision,
  listWorkspaceArtifactsByProject,
  migrateWorkspaceArtifactsProject,
  moveWorkspaceArtifactToProject,
  renameWorkspaceArtifact,
  restoreWorkspaceArtifactRevision,
  summarizeWorkspaceArtifactLineDiff,
  summarizeWorkspaceArtifactRevisionDiff,
  validateWorkspaceArtifactFormat,
  validateWorkspaceArtifactLanguage,
  validateWorkspaceArtifactTitle,
} from '../src/services/workspaceArtifacts';

function revision(
  overrides: Partial<WorkspaceArtifactRevision> = {}
): WorkspaceArtifactRevision {
  return {
    id: 'revision-1',
    content: '第一版',
    createdAt: 1,
    author: 'user',
    ...overrides,
  };
}

function artifact(overrides: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    id: 'artifact-1',
    projectId: 'project-1',
    title: '研究摘要',
    format: 'markdown',
    revisions: [revision()],
    activeRevisionId: 'revision-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: '# 本地研究成果\n\n正文',
    createdAt: 1,
    status: 'ready',
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('workspace artifact creation and validation', () => {
  it('creates a blank local artifact with one active user revision', () => {
    const source: WorkspaceArtifact[] = [];
    const created = createBlankWorkspaceArtifact(
      source,
      {
        projectId: ' project-1 ',
        title: '  草稿成果  ',
        format: 'code',
        language: ' TypeScript ',
      },
      { artifactId: 'artifact-new', revisionId: 'revision-new', now: 10 }
    );

    expect(source).toEqual([]);
    expect(created).toEqual([
      {
        id: 'artifact-new',
        projectId: 'project-1',
        title: '草稿成果',
        format: 'code',
        language: 'TypeScript',
        revisions: [
          {
            id: 'revision-new',
            content: '',
            createdAt: 10,
            author: 'user',
          },
        ],
        activeRevisionId: 'revision-new',
        createdAt: 10,
        updatedAt: 10,
      },
    ]);
  });

  it('copies only a ready user/assistant message and records exact source lineage', () => {
    const sourceMessage = message({
      id: 'branch-copy-message',
      originMessageId: 'canonical-message',
      content: '# 可追踪成果\n<script>alert("still text")</script>',
    });
    const created = createWorkspaceArtifactFromMessage(
      [],
      {
        projectId: 'project-1',
        sourceConversationId: 'conversation-branch',
        message: sourceMessage,
        format: 'html',
      },
      { artifactId: 'artifact-html', revisionId: 'revision-html', now: 20 }
    );

    expect(created[0]).toMatchObject({
      title: '可追踪成果',
      format: 'html',
      sourceConversationId: 'conversation-branch',
      sourceMessageId: 'branch-copy-message',
      activeRevisionId: 'revision-html',
    });
    expect(created[0].revisions[0]).toEqual({
      id: 'revision-html',
      content: '# 可追踪成果\n<script>alert("still text")</script>',
      createdAt: 20,
      author: 'assistant',
      sourceMessageId: 'branch-copy-message',
    });
    expect(sourceMessage).toHaveProperty('originMessageId', 'canonical-message');
  });

  it('derives and safely truncates a Unicode title without truncating message content', () => {
    const longHeading = `# ${'🧪'.repeat(150)}`;
    const created = createWorkspaceArtifactFromMessage(
      [],
      {
        projectId: 'project-1',
        sourceConversationId: 'conversation-1',
        message: message({ content: `${longHeading}\n完整正文` }),
      },
      { artifactId: 'artifact-2', revisionId: 'revision-2', now: 2 }
    );

    expect(Array.from(created[0].title)).toHaveLength(120);
    expect(created[0].title).toBe('🧪'.repeat(120));
    expect(created[0].revisions[0].content).toBe(`${longHeading}\n完整正文`);
  });

  it('rejects pending/error/system/empty source messages', () => {
    for (const status of ['pending', 'error', 'cancelled'] as const) {
      expect(() =>
        createWorkspaceArtifactFromMessage(
          [],
          {
            projectId: 'project-1',
            sourceConversationId: 'conversation-1',
            message: message({ status }),
          },
          { artifactId: `artifact-${status}`, revisionId: `revision-${status}`, now: 1 }
        )
      ).toThrow(/已完成/);
    }
    expect(() =>
      createWorkspaceArtifactFromMessage(
        [],
        {
          projectId: 'project-1',
          sourceConversationId: 'conversation-1',
          message: message({ role: 'system' }),
        },
        { artifactId: 'artifact-system', revisionId: 'revision-system', now: 1 }
      )
    ).toThrow(/系统消息/);
    expect(() =>
      createWorkspaceArtifactFromMessage(
        [],
        {
          projectId: 'project-1',
          sourceConversationId: 'conversation-1',
          message: message({ content: '' }),
        },
        { artifactId: 'artifact-empty', revisionId: 'revision-empty', now: 1 }
      )
    ).toThrow(/空消息/);
  });

  it('validates title, closed formats, inert language labels, identities, and timestamps', () => {
    expect(validateWorkspaceArtifactTitle('  正常标题  ')).toBe('正常标题');
    expect(validateWorkspaceArtifactLanguage(' C++ ')).toBe('C++');
    expect(validateWorkspaceArtifactLanguage('')).toBeUndefined();
    expect(validateWorkspaceArtifactFormat('plain-text')).toBe('plain-text');
    expect(() => validateWorkspaceArtifactTitle('x'.repeat(121))).toThrow(/120/);
    expect(() => validateWorkspaceArtifactTitle('标题\n注入')).toThrow(/控制字符/);
    expect(() => validateWorkspaceArtifactLanguage('html"><script>')).toThrow(/安全/);
    expect(() => validateWorkspaceArtifactLanguage('x'.repeat(41))).toThrow(/40/);
    expect(() => validateWorkspaceArtifactFormat('svg')).toThrow(/不支持/);
    expect(() =>
      createBlankWorkspaceArtifact(
        [],
        { projectId: '', title: 'x', format: 'markdown' },
        { artifactId: 'x', revisionId: 'r', now: 1 }
      )
    ).toThrow(/项目 ID/);
    expect(() =>
      createBlankWorkspaceArtifact(
        [],
        { projectId: 'p', title: 'x', format: 'markdown' },
        { artifactId: 'x', revisionId: 'r', now: Number.NaN }
      )
    ).toThrow(/时间戳/);
  });

  it('enforces workspace, content, and globally unique identity bounds', () => {
    const full = Array.from({ length: MAX_WORKSPACE_ARTIFACTS }, (_, index) =>
      artifact({
        id: `artifact-${index}`,
        revisions: [revision({ id: `revision-${index}` })],
        activeRevisionId: `revision-${index}`,
      })
    );
    expect(() =>
      createBlankWorkspaceArtifact(
        full,
        { projectId: 'p', title: 'overflow', format: 'markdown' },
        { artifactId: 'overflow', revisionId: 'overflow-revision', now: 1 }
      )
    ).toThrow(/200/);
    expect(() =>
      createBlankWorkspaceArtifact(
        [],
        {
          projectId: 'p',
          title: 'too large',
          format: 'plain-text',
          content: 'x'.repeat(MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH + 1),
        },
        { artifactId: 'too-large', revisionId: 'too-large-r', now: 1 }
      )
    ).toThrow(/500000/);
    expect(() =>
      createBlankWorkspaceArtifact(
        [artifact()],
        { projectId: 'p', title: 'duplicate', format: 'markdown' },
        { artifactId: 'artifact-1', revisionId: 'other-r', now: 1 }
      )
    ).toThrow(/成果 ID 已存在/);
    expect(() =>
      createBlankWorkspaceArtifact(
        [artifact()],
        { projectId: 'p', title: 'duplicate revision', format: 'markdown' },
        { artifactId: 'other', revisionId: 'revision-1', now: 1 }
      )
    ).toThrow(/版本 ID 已存在/);
  });
});

describe('workspace artifact revision history', () => {
  it('rejects revisions that would exceed the aggregate UTF-8 workspace budget', () => {
    const full = artifact({
      revisions: Array.from({ length: 4 }, (_, index) => revision({
        id: `revision-${index}`,
        content: 'x'.repeat(MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES / 4),
        createdAt: index,
      })),
      activeRevisionId: 'revision-3',
    });

    expect(() => appendUserWorkspaceArtifactRevision(
      [full],
      full.id,
      'x',
      { revisionId: 'over-total', now: 10 }
    )).toThrow(/UTF-8/);
  });

  it('renames and appends user/assistant revisions without mutating prior values', () => {
    const source = deepFreeze([artifact()]);
    const renamed = renameWorkspaceArtifact(source, 'artifact-1', '  新标题  ', 2);
    const userEdited = appendUserWorkspaceArtifactRevision(
      renamed,
      'artifact-1',
      '用户第二版',
      { revisionId: 'revision-2', now: 3 }
    );
    const assistantEdited = appendAssistantWorkspaceArtifactRevision(
      userEdited,
      'artifact-1',
      '模型第三版',
      'message-3',
      { revisionId: 'revision-3', now: 4 }
    );

    expect(source[0]).toMatchObject({ title: '研究摘要', updatedAt: 1 });
    expect(renamed[0]).toMatchObject({ title: '新标题', updatedAt: 2 });
    expect(userEdited[0]).toMatchObject({ activeRevisionId: 'revision-2', updatedAt: 3 });
    expect(assistantEdited[0]).toMatchObject({ activeRevisionId: 'revision-3', updatedAt: 4 });
    expect(assistantEdited[0].revisions).toEqual([
      revision(),
      { id: 'revision-2', content: '用户第二版', createdAt: 3, author: 'user' },
      {
        id: 'revision-3',
        content: '模型第三版',
        createdAt: 4,
        author: 'assistant',
        sourceMessageId: 'message-3',
      },
    ]);
  });

  it('restores old content by appending a new user revision instead of rewinding history', () => {
    const source = [
      artifact({
        revisions: [
          revision({ id: 'revision-old', content: '旧正文', sourceMessageId: 'message-old' }),
          revision({ id: 'revision-current', content: '当前正文', createdAt: 2 }),
        ],
        activeRevisionId: 'revision-current',
        updatedAt: 2,
      }),
    ];
    const restored = restoreWorkspaceArtifactRevision(
      source,
      'artifact-1',
      'revision-old',
      { revisionId: 'revision-restored', now: 3 }
    );

    expect(restored[0].revisions).toHaveLength(3);
    expect(restored[0].revisions[0]).toEqual(source[0].revisions[0]);
    expect(restored[0].revisions[2]).toEqual({
      id: 'revision-restored',
      content: '旧正文',
      createdAt: 3,
      author: 'user',
    });
    expect(restored[0].activeRevisionId).toBe('revision-restored');
    expect(source[0].activeRevisionId).toBe('revision-current');
    expect(() =>
      restoreWorkspaceArtifactRevision(source, 'artifact-1', 'missing', {
        revisionId: 'new',
        now: 3,
      })
    ).toThrow(/找不到/);
  });

  it('trims oldest expendable revisions but retains previous active and new current revisions', () => {
    const revisions = Array.from(
      { length: MAX_WORKSPACE_ARTIFACT_REVISIONS },
      (_, index) =>
        revision({
          id: `revision-${index}`,
          content: `content-${index}`,
          createdAt: index,
        })
    );
    const source = [
      artifact({
        revisions,
        activeRevisionId: 'revision-0',
        updatedAt: 49,
      }),
    ];
    const appended = appendWorkspaceArtifactRevision(
      source,
      'artifact-1',
      { content: 'latest', author: 'assistant', sourceMessageId: 'message-latest' },
      { revisionId: 'revision-50', now: 50 }
    );
    const ids = appended[0].revisions.map((item) => item.id);

    expect(appended[0].revisions).toHaveLength(MAX_WORKSPACE_ARTIFACT_REVISIONS);
    expect(ids).toContain('revision-0');
    expect(ids).toContain('revision-50');
    expect(ids).not.toContain('revision-1');
    expect(appended[0].activeRevisionId).toBe('revision-50');
    expect(source[0].revisions).toHaveLength(MAX_WORKSPACE_ARTIFACT_REVISIONS);
  });

  it('returns a detached active revision and fails closed for invalid active pointers', () => {
    const source = artifact();
    const active = getActiveWorkspaceArtifactRevision(source);
    expect(active).toEqual(revision());
    expect(active).not.toBe(source.revisions[0]);
    expect(getActiveWorkspaceArtifactRevision(artifact({ activeRevisionId: 'missing' }))).toBeUndefined();
    expect(getActiveWorkspaceArtifactRevision(undefined)).toBeUndefined();
  });
});

describe('workspace artifact project operations', () => {
  it('lists detached project artifacts in stable recency order', () => {
    const source = [
      artifact({ id: 'older', title: 'Older', updatedAt: 2 }),
      artifact({ id: 'other', projectId: 'project-2', updatedAt: 99 }),
      artifact({ id: 'newer', title: 'Newer', updatedAt: 3 }),
    ];
    const listed = listWorkspaceArtifactsByProject(source, 'project-1');
    expect(listed.map((item) => item.id)).toEqual(['newer', 'older']);
    expect(listed[0]).not.toBe(source[2]);
    expect(listed[0].revisions[0]).not.toBe(source[2].revisions[0]);
  });

  it('moves one artifact or migrates a deleted project without dropping revisions', () => {
    const source = deepFreeze([
      artifact({ id: 'move-one', projectId: 'old-project' }),
      artifact({ id: 'move-two', projectId: 'old-project', updatedAt: 2 }),
      artifact({ id: 'keep', projectId: 'keep-project', updatedAt: 3 }),
    ]);
    const moved = moveWorkspaceArtifactToProject(
      source,
      'move-one',
      'target-project',
      10
    );
    expect(moved.find((item) => item.id === 'move-one')).toMatchObject({
      projectId: 'target-project',
      updatedAt: 10,
    });
    expect(moved.find((item) => item.id === 'move-one')?.revisions).toEqual([revision()]);

    const migrated = migrateWorkspaceArtifactsProject(
      source,
      'old-project',
      'fallback-project',
      20
    );
    expect(
      migrated.filter((item) => item.id.startsWith('move')).map((item) => item.projectId)
    ).toEqual(['fallback-project', 'fallback-project']);
    expect(migrated.find((item) => item.id === 'keep')).toMatchObject({
      projectId: 'keep-project',
      updatedAt: 3,
    });
    expect(source[0].projectId).toBe('old-project');
    expect(() =>
      migrateWorkspaceArtifactsProject(source, 'same', 'same', 20)
    ).toThrow(/不能相同/);
  });

  it('deletes only the selected artifact and never mutates source/project data', () => {
    const source = deepFreeze([artifact(), artifact({ id: 'artifact-2' })]);
    const deleted = deleteWorkspaceArtifact(source, 'artifact-1');
    expect(deleted.map((item) => item.id)).toEqual(['artifact-2']);
    expect(source).toHaveLength(2);
    expect(() => deleteWorkspaceArtifact(source, 'missing')).toThrow(/找不到/);
  });
});

describe('bounded deterministic artifact diffs', () => {
  it('returns deterministic line additions/removals and revision comparisons', () => {
    const first = summarizeWorkspaceArtifactLineDiff(
      'alpha\nold\nomega',
      'alpha\nnew\nomega'
    );
    const second = summarizeWorkspaceArtifactLineDiff(
      'alpha\nold\nomega',
      'alpha\nnew\nomega'
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      beforeLineCount: 3,
      afterLineCount: 3,
      addedLines: 1,
      removedLines: 1,
      unchangedLines: 2,
      truncated: false,
    });
    expect(first.entries).toEqual([
      {
        kind: 'removed',
        text: 'old',
        oldLineNumber: 2,
        lineTruncated: false,
      },
      {
        kind: 'added',
        text: 'new',
        newLineNumber: 2,
        lineTruncated: false,
      },
    ]);

    const versioned = artifact({
      revisions: [
        revision({ id: 'old', content: 'alpha\nold\nomega' }),
        revision({ id: 'new', content: 'alpha\nnew\nomega' }),
      ],
      activeRevisionId: 'new',
    });
    expect(summarizeWorkspaceArtifactRevisionDiff(versioned, 'old', 'new')).toEqual(first);
    expect(() =>
      summarizeWorkspaceArtifactRevisionDiff(versioned, 'old', 'missing')
    ).toThrow(/找不到/);
  });

  it('bounds compared lines, emitted entries, and line preview length for mobile', () => {
    const lineBounded = summarizeWorkspaceArtifactLineDiff(
      'a\nb\nc\nd',
      'a\nx\ny\nz',
      { maxLines: 2, maxEntries: 1, maxLineLength: 8 }
    );
    expect(lineBounded).toMatchObject({
      beforeLineCount: 4,
      afterLineCount: 4,
      comparedBeforeLineCount: 2,
      comparedAfterLineCount: 2,
      truncated: true,
    });
    expect(lineBounded.entries).toHaveLength(1);

    const longLine = summarizeWorkspaceArtifactLineDiff('', '123456789', {
      maxLineLength: 5,
    });
    expect(longLine.entries).toEqual([
      {
        kind: 'added',
        text: '1234…',
        newLineNumber: 1,
        lineTruncated: true,
      },
    ]);
    expect(longLine.truncated).toBe(true);
    expect(() =>
      summarizeWorkspaceArtifactLineDiff('a', 'b', { maxLines: 0 })
    ).toThrow(/行数上限/);
  });

  it('keeps HTML and script-shaped content as inert unmodified strings', () => {
    const payload = '<script>globalThis.pwned = true</script>\n<img src=x onerror=alert(1)>';
    const created = createBlankWorkspaceArtifact(
      [],
      {
        projectId: 'project-1',
        title: '<script> is a text title',
        format: 'html',
        content: payload,
      },
      { artifactId: 'artifact-xss', revisionId: 'revision-xss', now: 1 }
    );
    expect(getActiveWorkspaceArtifactRevision(created[0])?.content).toBe(payload);
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });
});
