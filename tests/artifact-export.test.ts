import { describe, expect, it } from 'vitest';

import type { WorkspaceArtifact } from '../src/domain/types';
import { workspaceArtifactExportPayload } from '../src/services/artifactExport';
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  assertSupportedKnowledgeTextFile,
} from '../src/services/knowledgeFileIO';

function artifact(overrides: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    id: 'artifact-1',
    projectId: 'project-1',
    title: '需求 / 草稿',
    format: 'markdown',
    revisions: [{ id: 'revision-1', content: '# Hello', createdAt: 1, author: 'user' }],
    activeRevisionId: 'revision-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('artifact export and text knowledge file boundaries', () => {
  it('exports only the active revision with a safe extension and filename', () => {
    expect(workspaceArtifactExportPayload(artifact())).toEqual({
      filename: '需求 - 草稿.md',
      mimeType: 'text/markdown',
      content: '# Hello',
    });
    expect(workspaceArtifactExportPayload(artifact({ format: 'code', language: 'TypeScript' }))).toMatchObject({
      filename: '需求 - 草稿.ts',
      mimeType: 'text/plain',
    });
  });

  it('never executes or rewrites HTML content during export', () => {
    const content = '<script>fetch("https://example.com")</script>';
    expect(workspaceArtifactExportPayload(artifact({
      format: 'html',
      revisions: [{ id: 'html', content, createdAt: 1, author: 'assistant' }],
      activeRevisionId: 'html',
    }))).toEqual({
      filename: '需求 - 草稿.html.txt',
      mimeType: 'text/plain',
      content,
    });
  });

  it('accepts supported text/code formats and rejects binary or oversized claims', () => {
    expect(() => assertSupportedKnowledgeTextFile('notes.md', 'text/markdown', 100)).not.toThrow();
    expect(() => assertSupportedKnowledgeTextFile('source.ts', 'application/octet-stream', 100)).not.toThrow();
    expect(() => assertSupportedKnowledgeTextFile('config.yaml', 'application/yaml', 100)).not.toThrow();
    expect(() => assertSupportedKnowledgeTextFile('document.pdf', 'application/pdf', 100)).toThrow(/纯文本/);
    expect(() => assertSupportedKnowledgeTextFile('notes.txt', 'text/plain', MAX_KNOWLEDGE_FILE_BYTES + 1)).toThrow(/2 MB/);
  });
});
