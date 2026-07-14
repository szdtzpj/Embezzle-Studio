import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

function section(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

describe('v1.3 local knowledge and artifact integration', () => {
  it('routes every provider-bound chat path through the shared workspace context composer', async () => {
    const appSource = await source('src/features/chat/ChatPane.tsx');

    expect(appSource).not.toContain('buildChatTranscript(');
    const regenerate = section(appSource, 'async function regenerateAssistantMessage(', 'async function rerunFromUserMessage(');
    const rerun = section(appSource, 'async function rerunFromUserMessage(', 'async function saveEditedUserMessage(');
    const comparison = section(appSource, 'async function sendComparisonMessage(', 'async function sendMessage(');
    const ordinary = section(appSource, 'async function sendMessage(', 'function toggleSettingsScreen(');

    expect(regenerate).toContain('composeWorkspaceRequestTranscript(');
    expect(regenerate).toContain('item.id === triggerUser.id');
    expect(rerun).toContain('composeWorkspaceRequestTranscript(');
    expect(rerun).toContain('delete editedMessage.excludedFromContext;');
    expect(comparison).toContain('sharedComparisonTranscript = composeWorkspaceRequestTranscript(');
    expect(comparison).toContain('transcript: sharedComparisonTranscript');
    expect(ordinary).toContain("if (activeModelTask === 'chat')");
    expect(ordinary).toContain('composeWorkspaceRequestTranscript(');
    expect(ordinary).toContain('transcript = [userMessage];');
    expect(appSource).toContain('conversation?.knowledgeSourceIds ?? []');
    expect(appSource).toContain('buildProjectKnowledgeContext(');
    expect(appSource).toContain('knowledgeContextResult = selectedConversationKnowledgeContext(');
    expect(appSource).toContain('knowledgeContextResult.text');
  });

  it('keeps context preview and pending composer content on the same composition path', async () => {
    const [appSource, inspectorSource] = await Promise.all([
      source('src/features/chat/ChatPane.tsx'),
      source('src/components/ContextInspectorModal.tsx'),
    ]);

    expect(appSource).toContain('inspectWorkspaceRequestContext(');
    expect(appSource).toContain('messages={contextPreviewMessages}');
    expect(appSource).toContain("id: 'context-inspector-pending-user'");
    expect(inspectorSource).toContain("const pendingComposerMessageId = 'context-inspector-pending-user';");
    expect(inspectorSource).toContain("'即将发送'");
    expect(inspectorSource).toContain('readOnly || isPendingComposerMessage');
  });

  it('mounts the two large local tools only while open and exposes explicit capture actions', async () => {
    const [appSource, workbenchSource] = await Promise.all([
      source('src/features/chat/ChatPane.tsx'),
      source('src/components/WorkspaceWorkbench.tsx'),
    ]);

    expect(appSource).toContain('{workbenchOpen ? (');
    expect(appSource).toContain('<WorkspaceWorkbench');
    expect(appSource).toContain('{contextToolsAvailable && contextInspectorOpen && contextInspection ? (');
    expect(appSource).toContain('<ContextInspectorModal');
    expect(appSource).toContain('onSaveArtifact={() => saveMessageAsArtifact(message)}');
    expect(appSource).toContain('onSaveKnowledge={() => saveMessageAsKnowledge(message)}');
    expect(appSource).toContain('onRequestCompression={generateContextCompressionDraft}');
    expect(appSource).toContain('尚未调用任何模型');
    expect(appSource).toContain('const initialChatMessageRenderLimit = 160;');
    expect(appSource).toContain('{renderedChatMessages.map((message) => {');
    expect(workbenchSource).toContain("'plain-text'");
    expect(workbenchSource).toContain("'code'");
    expect(workbenchSource).toContain("'json'");
    expect(workbenchSource).toContain("'html'");
    expect(workbenchSource).toContain('confirmDiscard(artifactDirty');
    expect(workbenchSource).toContain('confirmDiscard(knowledgeDirty');
    expect(workbenchSource).toContain('const knowledgeSearchEnabled = Boolean(deferredKnowledgeQuery);');
    expect(workbenchSource).toContain('}, [knowledgeSearchEnabled, knowledgeSources]);');
    expect(workbenchSource).not.toContain('}, [deferredKnowledgeQuery, knowledgeSources]);');
  });

  it('reuses project-reference projection while only messages are streaming', async () => {
    const appSource = await source('src/features/chat/ChatPane.tsx');
    const cacheSection = section(
      appSource,
      'const workspaceKnowledgeContextCache = new WeakMap<',
      'function workspaceRequestContextOptions('
    );

    expect(cacheSection).toContain('workspaceKnowledgeContextCache.get(workspace.knowledgeSources)');
    expect(cacheSection).toContain('workspaceKnowledgeContextCacheEntries = 128');
    expect(cacheSection).toContain('JSON.stringify([projectId, selectedSourceIds])');
    expect(cacheSection).not.toContain('workspaceKnowledgeContextCache.get(workspace)');
  });

  it('migrates project-owned data and keeps source selection bounded and explicit', async () => {
    const [appSource, projectsReducer] = await Promise.all([
      source('src/features/chat/ChatPane.tsx'),
      source('src/features/projects/internal/projectConversationReducer.ts'),
    ]);

    expect(projectsReducer).toContain('migrateWorkspaceArtifactsProject(');
    expect(projectsReducer).toContain('migrateProjectKnowledgeSources(');
    expect(appSource).toContain('MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES');
    expect(projectsReducer).toContain('delete next.knowledgeSourceIds;');
    expect(projectsReducer).toContain('delete next.sourceArtifactId;');
    expect(appSource).toContain('不会自动加入模型上下文');
  });

  it('never adds an executable artifact or project-reference preview surface', async () => {
    const sources = await Promise.all([
      source('src/components/WorkspaceWorkbench.tsx'),
      source('src/components/ContextInspectorModal.tsx'),
      source('src/services/artifactExport.ts'),
      source('src/services/projectKnowledge.ts'),
    ]);
    const combined = sources.join('\n');

    expect(combined).not.toMatch(/\bWebView\b/);
    expect(combined).not.toContain('dangerouslySetInnerHTML');
    expect(combined).not.toMatch(/\beval\s*\(/);
    expect(combined).not.toContain('new Function(');
    expect(combined).not.toContain('fetch(');
  });
});
