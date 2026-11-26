import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceCommitRejectedError } from '../../../src/app/workspace/internal/WorkspaceCommitPort';
import {
  WORKSPACE_SAVE_DEBOUNCE_MS,
  WorkspaceSession,
} from '../../../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatMessage,
  ProviderUsageEvent,
} from '../../../src/domain/types';
import type {
  ChatLease,
  ChatOrchestrationController,
} from '../../../src/features/chat/internal/ChatContext';
import { ChatRequestDecisionQueue } from '../../../src/features/chat/internal/decisions/useChatRequestDecisions';
import { ChatRequestExecution } from '../../../src/features/chat/internal/requests/ChatRequestExecution';
import { ChatUsageLedger } from '../../../src/features/chat/internal/requests/ChatUsageLedger';
import type { ProviderAdapter, ProviderAdapterRegistry } from '../../../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  createProjectsCommitReducer,
  ProjectsConversationsRuntime,
} from '../../../src/features/projects/ProjectsConversationsRuntime';
import type { ProviderMcpApprovalRequest } from '../../../src/services/providerMcp';
import {
  buildWorkspaceSearchIndex,
  MAX_WORKSPACE_SEARCH_DOCUMENTS,
  MAX_WORKSPACE_SEARCH_RESULTS,
  searchWorkspace,
  searchWorkspaceIndex,
} from '../../../src/services/workspaceSearch';
import { createE2EWorkspaceHarness } from '../helpers/e2eWorkspaceHarness';

const storageMocks = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  secureAvailable: true,
  asyncGet: vi.fn<(key: string) => Promise<string | null>>(),
  asyncSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  asyncRemove: vi.fn<(key: string) => Promise<void>>(),
  secureIsAvailable: vi.fn<() => Promise<boolean>>(),
  secureGet: vi.fn<(key: string) => Promise<string | null>>(),
  secureSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  secureDelete: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: storageMocks.asyncGet,
    setItem: storageMocks.asyncSet,
    removeItem: storageMocks.asyncRemove,
  },
}));

vi.mock('expo-secure-store', () => ({
  isAvailableAsync: storageMocks.secureIsAvailable,
  getItemAsync: storageMocks.secureGet,
  setItemAsync: storageMocks.secureSet,
  deleteItemAsync: storageMocks.secureDelete,
}));

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(17),
}));

const WORKSPACE_KEY = '@embezzle-studio/workspace-v7';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v7.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v7';
const LEGACY_V1_KEY = '@embezzle-studio/workspace-v1';
const V2_WORKSPACE_KEY = '@embezzle-studio/workspace-v2';

function createSessionLeaseController(): {
  controller: AbortController;
  orchestration: ChatOrchestrationController;
} {
  const controller = new AbortController();
  let activeLease: ChatLease | null = null;
  const orchestration: ChatOrchestrationController = {
    current: () => activeLease,
    begin: ({ phase, label, mcpActive = false }) => {
      if (activeLease) return null;
      activeLease = { controller, label, phase, mcpActive };
      return activeLease;
    },
    transition: (lease, phase) => {
      if (!activeLease || activeLease !== lease) return false;
      activeLease.phase = phase;
      return true;
    },
    finish: (lease) => {
      if (activeLease === lease) activeLease = null;
    },
    stop: () => {
      controller.abort();
    },
  };
  return { controller, orchestration };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolver: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolver?.();
    },
  };
}

function makeMcpRequest(id: string, toolName = 'search_docs'): ProviderMcpApprovalRequest {
  const args = { query: `q-${id}` };
  const rawArguments = JSON.stringify(args);
  return {
    id,
    serverLabel: 'docs-mcp',
    toolName,
    rawArguments,
    arguments: args,
    argumentBytes: Buffer.byteLength(rawArguments, 'utf8'),
  };
}

async function raceWithTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 400): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Deadlock] "${label}" 在 ${timeoutMs}ms 内未结算。`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

describe('F8: 工作区生命周期、隔离持久化、搜索与并发决策防死锁 E2E', () => {
  const restoreCallbacks: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    storageMocks.asyncValues.clear();
    storageMocks.secureValues.clear();
    storageMocks.secureAvailable = true;

    storageMocks.asyncGet.mockImplementation(async (key: string) =>
      storageMocks.asyncValues.get(key) ?? null
    );
    storageMocks.asyncSet.mockImplementation(async (key: string, value: string) => {
      storageMocks.asyncValues.set(key, value);
    });
    storageMocks.asyncRemove.mockImplementation(async (key: string) => {
      storageMocks.asyncValues.delete(key);
    });
    storageMocks.secureIsAvailable.mockImplementation(async () => storageMocks.secureAvailable);
    storageMocks.secureGet.mockImplementation(async (key: string) =>
      storageMocks.secureValues.get(key) ?? null
    );
    storageMocks.secureSet.mockImplementation(async (key: string, value: string) => {
      storageMocks.secureValues.set(key, value);
    });
    storageMocks.secureDelete.mockImplementation(async (key: string) => {
      storageMocks.secureValues.delete(key);
    });
  });

  afterEach(async () => {
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      await restore?.();
    }
  });

  describe('Tier 1 — 核心正常路径', () => {
    it('F8-T1-1: 工作区多轮保存、450ms 防抖与强制持久化及重启重加载一致', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      await harness.addAndSelectProvider({
        id: 'f8-openai',
        name: 'F8 OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-f8-test',
        capabilities: ['text', 'streaming'],
        models: [{ id: 'gpt-5', capabilities: ['text', 'streaming'], source: 'manual' }],
      });
      await harness.flush();

      const convId = harness.session.getSnapshot().activeConversationId;
      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: '未发送草稿内容',
        now: harness.clock.now(),
      });

      // 防抖到期前，持久快照尚未落入草稿
      const beforeDebounce = harness.persistence.getStoredSnapshot();
      expect(
        beforeDebounce?.composerDrafts.some((draft) => draft.text === '未发送草稿内容')
      ).toBe(false);
      expect(harness.session.getStatus().dirty).toBe(true);

      // 步进至 450ms 防抖窗口，验证自动落盘
      harness.clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
      await harness.session.settle();
      const afterDebounce = harness.persistence.getStoredSnapshot();
      expect(
        afterDebounce?.composerDrafts.some(
          (draft) => draft.conversationId === convId && draft.text === '未发送草稿内容'
        )
      ).toBe(true);
      expect(harness.session.getStatus().dirty).toBe(false);

      // 发送消息自动清理对应 composerDrafts 并强制刷盘
      const userMessage: ChatMessage = {
        id: harness.ids.createId('msg'),
        role: 'user',
        content: '第一轮核心提问',
        createdAt: harness.clock.now(),
        status: 'ready',
      };
      await harness.chatRuntime.execute({
        type: 'chat.append-messages',
        conversationId: convId,
        messages: [userMessage],
        now: harness.clock.now(),
        removeWelcome: true,
      });
      await harness.flush();

      // 模拟应用冷重启：基于同一 persistence 装配新 WorkspaceSession
      const rebootedSession = new WorkspaceSession({
        persistence: harness.persistence,
        clock: harness.clock,
        lifecycle: harness.lifecycle,
        trace: harness.trace,
        autoBoot: false,
      });
      restoreCallbacks.push(() => rebootedSession.dispose());
      await rebootedSession.boot();

      const rebooted = rebootedSession.getSnapshot();
      expect(rebooted.activeProviderId).toBe('f8-openai');
      expect(rebooted.activeModelIdByProvider['f8-openai']).toBe('gpt-5');
      expect(rebooted.composerDrafts.some((draft) => draft.conversationId === convId)).toBe(false);
      expect(rebooted.messages.some((m) => m.id === userMessage.id && m.content === '第一轮核心提问')).toBe(
        true
      );
    });

    it('F8-T1-2: 旧版本 JSON（无 schemaVersion 与 v2）向后兼容加载并升级保存且剥离明文密钥', async () => {
      vi.resetModules();
      const storage = await import('../../../src/services/storage');

      // 场景 1：无 schemaVersion 的 legacy v1 快照（含明文 apiKey 与中断 pending 消息）
      const base = createDefaultWorkspace();
      const legacyPayload = {
        providers: [
          {
            ...base.providers[0],
            id: 'legacy-provider',
            name: 'Legacy OpenAI',
            apiKey: 'sk-legacy-plaintext-123',
          },
        ],
        activeProviderId: 'legacy-provider',
        activeModelIdByProvider: { 'legacy-provider': base.providers[0].models[0]?.id ?? 'gpt-4o' },
        messages: [
          { id: 'u1', role: 'user', content: '旧版本问题', createdAt: 1000, status: 'ready' },
          { id: 'a1', role: 'assistant', content: '半截响应', createdAt: 1001, status: 'pending' },
        ],
      };
      storageMocks.asyncValues.set(LEGACY_V1_KEY, JSON.stringify(legacyPayload));

      const migratedFromV1 = await storage.loadWorkspace();
      expect(migratedFromV1).not.toBeNull();
      if (!migratedFromV1) throw new Error('Expected v1 workspace to load.');
      expect(migratedFromV1.projects.length).toBeGreaterThanOrEqual(1);
      expect(migratedFromV1.conversations.length).toBeGreaterThanOrEqual(1);
      expect(migratedFromV1.costGuard).toBeDefined();
      expect(migratedFromV1.providerUsageEvents).toEqual([]);
      const interruptedMsg = migratedFromV1.messages.find((m) => m.id === 'a1');
      expect(interruptedMsg?.status).toBe('error');

      await storage.saveWorkspace({
        ...migratedFromV1,
        providers: migratedFromV1.providers.map((p) =>
          p.id === 'legacy-provider' ? { ...p, apiKey: 'sk-legacy-plaintext-123' } : p
        ),
      });
      const savedV7Raw = storageMocks.asyncValues.get(WORKSPACE_KEY);
      expect(savedV7Raw).toBeDefined();
      const savedEnvelope = JSON.parse(savedV7Raw ?? '{}') as {
        schemaVersion: number;
        workspace: AppWorkspace;
      };
      expect(savedEnvelope.schemaVersion).toBe(7);
      // 原生 SecureStore 可用时，主快照绝不留存明文 apiKey，而是绑定写入 SecureStore
      expect(savedV7Raw).not.toContain('sk-legacy-plaintext-123');
      expect(Array.from(storageMocks.secureValues.values()).join('\n')).toContain(
        'sk-legacy-plaintext-123'
      );

      // 场景 2：schemaVersion: 2 旧信封向后兼容加载
      vi.resetModules();
      storageMocks.asyncValues.clear();
      storageMocks.secureValues.clear();
      const storageV2 = await import('../../../src/services/storage');
      storageMocks.asyncValues.set(
        V2_WORKSPACE_KEY,
        JSON.stringify({
          schemaVersion: 2,
          revision: 3,
          savedAt: 12345,
          workspace: {
            providers: base.providers.map((p) => ({ ...p, apiKey: undefined })),
            activeProviderId: base.activeProviderId,
            activeModelIdByProvider: base.activeModelIdByProvider,
            reasoningEffortByModel: {},
            parameterSettings: base.parameterSettings,
            modelCandidatesByProvider: {},
            activeConversationId: base.activeConversationId,
            conversations: base.conversations,
            plugins: [],
          },
        })
      );
      const loadedV2 = await storageV2.loadWorkspace();
      expect(loadedV2).not.toBeNull();
      expect(loadedV2?.projects.length).toBeGreaterThanOrEqual(1);
      expect(loadedV2?.costGuard).toBeDefined();
      await storageV2.saveWorkspace(loadedV2 as AppWorkspace);
      const upgradedV2Envelope = JSON.parse(
        storageMocks.asyncValues.get(WORKSPACE_KEY) ?? '{}'
      ) as { schemaVersion?: number };
      expect(upgradedV2Envelope.schemaVersion).toBe(7);
    });

    it('F8-T1-3: 项目/对话分支、重命名、置顶、跨项目移动与删除联动一致性', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      const deletedConversationIds: string[] = [];
      const historyLocked = false;
      const runtime = new ProjectsConversationsRuntime({
        commit: harness.session.bindCommitPort(createProjectsCommitReducer()),
        now: () => harness.clock.now(),
        createId: (prefix) => harness.ids.createId(prefix),
        isHistoryLocked: () => historyLocked,
        onConversationDeleted: async (conversationId) => {
          deletedConversationIds.push(conversationId);
        },
      });

      // 创建两个项目
      const projARes = await runtime.execute({
        type: 'project.create',
        input: { name: '项目 Alpha' },
      });
      expect(projARes.ok).toBe(true);
      const projectAId = harness.session.getSnapshot().activeProjectId;

      const projBRes = await runtime.execute({
        type: 'project.create',
        input: { name: '项目 Beta' },
      });
      expect(projBRes.ok).toBe(true);
      const projectBId = harness.session.getSnapshot().activeProjectId;
      expect(projectBId).not.toBe(projectAId);

      // 在项目 Alpha 新建对话并写入两条消息
      const convRes = await runtime.execute({
        type: 'conversation.start',
        projectId: projectAId,
      });
      expect(convRes.ok).toBe(true);
      const parentConvId = harness.session.getSnapshot().activeConversationId;

      const msgUserId = harness.ids.createId('msg');
      const msgAssistantId = harness.ids.createId('msg');
      await harness.chatRuntime.execute({
        type: 'conversation.set-messages',
        conversationId: parentConvId,
        projectId: projectAId,
        now: harness.clock.now(),
        messages: [
          {
            id: msgUserId,
            role: 'user',
            content: '原始问题',
            createdAt: 100,
            status: 'ready',
            attachments: [
              { id: 'att-orphan-1', kind: 'image', name: 'chart.png', mimeType: 'image/png', uri: 'file:///chart.png' },
            ],
          },
          {
            id: msgAssistantId,
            role: 'assistant',
            content: '原始回答',
            createdAt: 101,
            status: 'ready',
            comparisonGroupId: 'cmp-group-1',
          },
        ],
      });

      // 创建分支
      harness.clock.advance(50);
      const forkRes = await runtime.execute({
        type: 'conversation.fork',
        conversationId: parentConvId,
        messageId: msgAssistantId,
      });
      expect(forkRes.ok).toBe(true);
      const forkConvId = harness.session.getSnapshot().activeConversationId;
      expect(forkConvId).not.toBe(parentConvId);

      const forkedConv = harness.session
        .getSnapshot()
        .conversations.find((c) => c.id === forkConvId);
      expect(forkedConv?.parentConversationId).toBe(parentConvId);
      expect(forkedConv?.branchPointMessageId).toBe(msgAssistantId);
      expect(forkedConv?.messages.map((m) => m.id)).not.toContain(msgAssistantId);
      expect(forkedConv?.messages[1]?.originMessageId).toBe(msgAssistantId);

      // 重命名并置顶分支
      const renameRes = await runtime.execute({
        type: 'conversation.rename',
        conversationId: forkConvId,
        title: '  重点分支对话  ',
      });
      expect(renameRes.ok).toBe(true);
      const pinRes = await runtime.execute({
        type: 'conversation.pin',
        conversationId: forkConvId,
        pinned: true,
      });
      expect(pinRes.ok).toBe(true);

      const pinnedSnapshot = harness.session.getSnapshot();
      const renamedFork = pinnedSnapshot.conversations.find((c) => c.id === forkConvId);
      expect(renamedFork?.title).toBe('重点分支对话');
      expect(renamedFork?.customTitle).toBe(true);
      expect(pinnedSnapshot.conversations[0]?.id).toBe(forkConvId);

      // 跨项目移动父对话至项目 Beta（验证清理知识源并脱离跨项目分支）
      const moveRes = await runtime.execute({
        type: 'conversation.move',
        conversationId: parentConvId,
        projectId: projectBId,
      });
      expect(moveRes.ok).toBe(true);
      const movedParent = harness.session
        .getSnapshot()
        .conversations.find((c) => c.id === parentConvId);
      expect(movedParent?.projectId).toBe(projectBId);
      expect(movedParent?.knowledgeSourceIds ?? []).toEqual([]);

      // 删除父对话前，向父对话追加一条父分支独有的附件消息，以验证共享附件保留而独有附件进入 orphanedAttachments
      await harness.chatRuntime.execute({
        type: 'chat.append-messages',
        conversationId: parentConvId,
        projectId: projectBId,
        now: harness.clock.now(),
        messages: [
          {
            id: harness.ids.createId('msg'),
            role: 'user',
            content: '父对话独有附件消息',
            createdAt: 105,
            status: 'ready',
            attachments: [
              { id: 'att-parent-only-2', kind: 'image', name: 'only-parent.png', mimeType: 'image/png', uri: 'file:///only-parent.png' },
            ],
          },
        ],
      });

      // 删除父对话：子分支应继续存活并解除已删父分支挂接，共享附件不孤立、独有附件上报 orphanedAttachments
      const delConvRes = await runtime.execute({
        type: 'conversation.delete',
        conversationId: parentConvId,
      });
      expect(delConvRes.ok).toBe(true);
      if (!delConvRes.ok) throw new Error('Expected conversation delete to succeed.');
      expect(deletedConversationIds).toEqual([parentConvId]);
      expect(delConvRes.orphanedAttachments?.some((att) => att.id === 'att-orphan-1')).toBe(false);
      expect(delConvRes.orphanedAttachments?.some((att) => att.id === 'att-parent-only-2')).toBe(
        true
      );

      const remainingFork = harness.session
        .getSnapshot()
        .conversations.find((c) => c.id === forkConvId);
      expect(remainingFork).toBeDefined();
      expect(remainingFork?.parentConversationId).toBeUndefined();

      // 删除项目 Alpha，将其所属对话迁入项目 Beta
      const delProjRes = await runtime.execute({
        type: 'project.delete',
        projectId: projectAId,
        fallbackProjectId: projectBId,
      });
      expect(delProjRes.ok).toBe(true);
      const afterProjDel = harness.session.getSnapshot();
      expect(afterProjDel.projects.some((p) => p.id === projectAId)).toBe(false);
      expect(afterProjDel.conversations.find((c) => c.id === forkConvId)?.projectId).toBe(
        projectBId
      );
      expect(historyLocked).toBe(false);
    });

    it('F8-T1-4: 工作区全局有界搜索（NFKC 归一化、权重排序、附件/提示词匹配与凭据零泄漏）', () => {
      const base = createDefaultWorkspace();
      const secretToken = 'sk-super-secret-leak-check-999';
      const sourceWithSecret = {
        projects: [
          {
            id: 'proj-ai',
            name: 'ＡＩ 研究项目',
            systemPrompt: '请专注深度分析模型架构',
            createdAt: 1000,
            updatedAt: 5000,
          },
        ],
        conversations: [
          {
            id: 'conv-1',
            projectId: 'proj-ai',
            title: 'AI 研究周报',
            createdAt: 1000,
            updatedAt: 6000,
            messages: [
              {
                id: 'm-1',
                role: 'user' as const,
                content: '请核对季度报表数据',
                reasoningContent: '包含 ai 研究 推理关键词',
                createdAt: 6001,
                status: 'ready' as const,
                attachments: [
                  {
                    id: 'att-csv',
                    kind: 'file' as const,
                    name: 'quarter.csv',
                    mimeType: 'text/csv',
                    uri: 'file:///quarter.csv',
                  },
                ],
              },
            ],
          },
        ],
        promptTemplates: [
          {
            id: 'tpl-1',
            name: 'AI 研究摘要模板',
            content: '总结重点',
            mode: 'system' as const,
            createdAt: 1000,
            updatedAt: 4000,
          },
        ],
        // 恶意或误传的敏感字段，必须被严格隔离在搜索索引之外
        providers: [{ ...base.providers[0], apiKey: secretToken }],
        plugins: [{ id: 'plg-1', authorization: `Bearer ${secretToken}` }],
      };

      const index = buildWorkspaceSearchIndex(sourceWithSecret);
      expect(JSON.stringify(index)).not.toContain(secretToken);

      // 全角字母 + 空白折叠查询
      const titleResults = searchWorkspaceIndex(index, '  ＡＩ\t研究  ');
      expect(titleResults.length).toBeGreaterThanOrEqual(3);
      expect(titleResults[0]?.matchedField).toBe('title');
      expect(titleResults.some((r) => r.conversationId === 'conv-1')).toBe(true);

      // 附件名称匹配
      const csvResults = searchWorkspaceIndex(index, 'quarter.csv');
      expect(csvResults.length).toBe(1);
      expect(csvResults[0]?.matchedField).toBe('attachment');
      expect(csvResults[0]?.messageId).toBe('m-1');
      expect(csvResults[0]?.projectId).toBe('proj-ai');

      // 密钥绝不可被检索命中
      expect(searchWorkspace(sourceWithSecret, secretToken)).toEqual([]);
    });

    it('F8-T1-5: 费用确认与 MCP 工具审批 Promise 正常确认/拒绝与 nonce 严格绑定', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      // 配置超限预警的费用保险丝
      await harness.settingsRuntime.execute({
        type: 'cost-guard.update',
        patch: {
          enabled: true,
          dailyUsdBudget: 0.01,
          limitAction: 'warn',
        },
      });
      await harness.settingsRuntime.execute({
        type: 'pricing.update',
        providerId: harness.session.getSnapshot().activeProviderId,
        modelId: 'gpt-5',
        patch: {
          currency: 'USD',
          inputPerMillion: 50,
          outputPerMillion: 100,
        },
        now: harness.clock.now(),
      });

      const ledger = new ChatUsageLedger({
        readWorkspace: () => harness.session.getSnapshot(),
        isReplacing: () => harness.session.isReplacing(),
        replaceUsageEvents: (events: ProviderUsageEvent[]) =>
          harness.chatRuntime.execute({ type: 'usage.replace', events }),
        flushRequired: () => harness.flush(),
        confirmCost: (reason) => harness.decisionQueue.requestCostConfirmation(reason),
        notify: () => undefined,
        now: () => harness.clock.now(),
      });

      // 写入一条已有高额费用事件，触发 warn 弹窗
      const priorEvent = ledger.createStarted({
        id: 'usage-prior',
        providerId: harness.session.getSnapshot().activeProviderId,
        modelId: 'gpt-5',
        kind: 'chat',
        createdAt: harness.clock.now(),
      });
      await ledger.finish(priorEvent, 'succeeded', {
        amount: 0.05,
        currency: 'USD',
        source: 'user-configured',
        pricingUpdatedAt: harness.clock.now(),
      });

      const authPromise = ledger.authorize({
        operations: [
          {
            kind: 'chat',
            providerId: harness.session.getSnapshot().activeProviderId,
            modelId: 'gpt-5',
          },
        ],
      });
      // 等待微任务刷新队列快照
      await Promise.resolve();
      expect(harness.decisionQueue.getSnapshot().costConfirmationReason).toBeTruthy();

      harness.decisionQueue.resolveCostConfirmation(true);
      await expect(authPromise).resolves.toBe(true);
      expect(harness.decisionQueue.getSnapshot().costConfirmationReason).toBeNull();

      // MCP 审批确认与拒绝及 nonce 校验
      const req1 = makeMcpRequest('mcp-req-1', 'read_repo');
      const mcpPromise1 = harness.decisionQueue.requestMcpApproval(req1, {
        providerName: 'OpenAI',
        modelId: 'gpt-5',
        serverName: 'Repo MCP',
        endpoint: 'https://mcp.example.com/sse',
      });
      const snap1 = harness.decisionQueue.getSnapshot().mcpApprovalView;
      expect(snap1?.approvalRequestId).toBe('mcp-req-1');
      if (!snap1) throw new Error('Expected mcpApprovalView to be populated.');

      // 错 nonce 不得误结算
      harness.decisionQueue.resolveMcpApproval(
        { approvalRequestId: snap1.approvalRequestId, nonce: snap1.approvalNonce + 99 },
        'deny'
      );
      expect(harness.decisionQueue.getSnapshot().mcpApprovalView).not.toBeNull();

      harness.decisionQueue.resolveMcpApproval(
        { approvalRequestId: snap1.approvalRequestId, nonce: snap1.approvalNonce },
        'approve'
      );
      await expect(mcpPromise1).resolves.toBe('approve');
      expect(harness.decisionQueue.getSnapshot().mcpApprovalView).toBeNull();

      // 第二次请求测试 deny
      const req2 = makeMcpRequest('mcp-req-2', 'write_file');
      const mcpPromise2 = harness.decisionQueue.requestMcpApproval(req2, {
        providerName: 'OpenAI',
        modelId: 'gpt-5',
        serverName: 'Repo MCP',
        endpoint: 'https://mcp.example.com/sse',
      });
      const snap2 = harness.decisionQueue.getSnapshot().mcpApprovalView;
      if (!snap2) throw new Error('Expected second mcpApprovalView.');
      harness.decisionQueue.resolveMcpApproval(
        { approvalRequestId: snap2.approvalRequestId, nonce: snap2.approvalNonce },
        'deny'
      );
      await expect(mcpPromise2).resolves.toBe('deny');
    });

    it('F8-T1-6: 跨会话并发隔离：中止会话 A 不影响会话 B 完整流式结束与落盘', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      await harness.addAndSelectProvider({
        id: 'iso-provider',
        name: 'Isolation OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-iso-test',
        capabilities: ['text', 'streaming'],
        models: [{ id: 'gpt-5', capabilities: ['text', 'streaming'], source: 'manual' }],
      });
      const snapWithProvider = harness.session.getSnapshot();
      const provider = snapWithProvider.providers.find((p) => p.id === 'iso-provider');
      const model = provider?.models[0];
      if (!provider || !model) throw new Error('Expected test provider and model.');

      const convA = 'conv-isolation-a';
      const convB = 'conv-isolation-b';
      const msgAId = 'assistant-iso-a';
      const msgBId = 'assistant-iso-b';

      await harness.chatRuntime.execute({
        type: 'conversation.set-messages',
        conversationId: convA,
        activate: false,
        now: harness.clock.now(),
        messages: [
          { id: 'u-a', role: 'user', content: 'A 问题', createdAt: 10, status: 'ready' },
          { id: msgAId, role: 'assistant', content: '', createdAt: 11, status: 'pending' },
        ],
      });
      await harness.chatRuntime.execute({
        type: 'conversation.set-messages',
        conversationId: convB,
        activate: false,
        now: harness.clock.now(),
        messages: [
          { id: 'u-b', role: 'user', content: 'B 问题', createdAt: 12, status: 'ready' },
          { id: msgBId, role: 'assistant', content: '', createdAt: 13, status: 'pending' },
        ],
      });

      const sessionA = createSessionLeaseController();
      const sessionB = createSessionLeaseController();
      const leaseA = sessionA.orchestration.begin({ phase: 'provider-request', label: 'A' });
      const leaseB = sessionB.orchestration.begin({ phase: 'provider-request', label: 'B' });
      expect(leaseA).not.toBeNull();
      expect(leaseB).not.toBeNull();

      const bDeferred = createDeferred();

      const adapterA: ProviderAdapter = {
        run: (request) =>
          new Promise((_resolve, reject) => {
            request.onStreamUpdate?.({ content: '会话A半截内容' });
            request.signal?.addEventListener(
              'abort',
              () => {
                const err = new Error('Aborted A');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true }
            );
          }),
        queryTask: async () => ({ content: '', raw: undefined }),
      };

      const adapterB: ProviderAdapter = {
        run: async (request) => {
          request.onStreamUpdate?.({ content: '会话B前置片段-' });
          await bDeferred.promise;
          return { content: '会话B前置片段-完整答案', raw: undefined };
        },
        queryTask: async () => ({ content: '', raw: undefined }),
      };

      const registryFor = (adapter: ProviderAdapter): ProviderAdapterRegistry => ({
        resolve: () => adapter,
      });

      const createHost = () => ({
        readWorkspace: () => harness.session.getSnapshot(),
        appState: () => 'active' as const,
        streamUpdateDelayMs: () => 0,
        discardAttachments: async () => undefined,
        authorize: async () => true,
        persistUsageEvents: async () => undefined,
        finishUsageEvent: async () => undefined,
        requestMcpApproval: async () => 'cancel' as const,
        updateAssistantMessage: (
          messageId: string,
          patch: Partial<ChatMessage>,
          conversationId: string
        ) => {
          void harness.chatRuntime.execute({
            type: 'message.update',
            messageId,
            patch,
            conversationId,
            now: harness.clock.now(),
          });
        },
        notify: () => undefined,
      });

      const execA = new ChatRequestExecution(
        registryFor(adapterA),
        sessionA.orchestration,
        createHost()
      );
      const execB = new ChatRequestExecution(
        registryFor(adapterB),
        sessionB.orchestration,
        createHost()
      );

      const promiseA = execA.execute({
        assistantMessage: { id: msgAId, role: 'assistant', content: '', createdAt: 11, status: 'pending' },
        conversationId: convA,
        transcript: [{ id: 'u-a', role: 'user', content: 'A 问题', createdAt: 10, status: 'ready' }],
        runtime: { provider, model, modelId: model.id, reasoningEffort: 'default' },
        controller: sessionA.controller,
        usageEvent: {
          id: 'usage-a',
          providerId: provider.id,
          modelId: model.id,
          kind: 'chat',
          status: 'started',
          createdAt: 10,
          localDateKey: '2026-11-25',
          unknownCostComponents: [],
          providerRequestCount: 1,
        },
        parameterSettings: harness.session.getSnapshot().parameterSettings,
      });

      const promiseB = execB.execute({
        assistantMessage: { id: msgBId, role: 'assistant', content: '', createdAt: 13, status: 'pending' },
        conversationId: convB,
        transcript: [{ id: 'u-b', role: 'user', content: 'B 问题', createdAt: 12, status: 'ready' }],
        runtime: { provider, model, modelId: model.id, reasoningEffort: 'default' },
        controller: sessionB.controller,
        usageEvent: {
          id: 'usage-b',
          providerId: provider.id,
          modelId: model.id,
          kind: 'chat',
          status: 'started',
          createdAt: 12,
          localDateKey: '2026-11-25',
          unknownCostComponents: [],
          providerRequestCount: 1,
        },
        parameterSettings: harness.session.getSnapshot().parameterSettings,
      });

      // 中止会话 A，并让会话 B 继续完成
      await new Promise((r) => setTimeout(r, 15));
      sessionA.orchestration.stop();
      const outcomeA = await promiseA;
      expect(outcomeA.status).toBe('cancelled');

      bDeferred.resolve();
      const outcomeB = await promiseB;
      expect(outcomeB.status).toBe('success');
      await harness.flush();

      const snap = harness.session.getSnapshot();
      const finalMsgA = snap.conversations
        .find((c) => c.id === convA)
        ?.messages.find((m) => m.id === msgAId);
      const finalMsgB = snap.conversations
        .find((c) => c.id === convB)
        ?.messages.find((m) => m.id === msgBId);

      expect(finalMsgA?.status).toBe('cancelled');
      expect(finalMsgA?.content).toBe('会话A半截内容');
      expect(finalMsgB?.status).toBe('ready');
      expect(finalMsgB?.content).toBe('会话B前置片段-完整答案');
    });
  });

  describe('Tier 2 — 边界条件、异常恢复与防死锁', () => {
    it('F8-T2-1: 存储损坏自动从备份降级恢复 & 无备份进入只读隔离保护且拒写', async () => {
      // 场景 A：主存储损坏但存在有效备份 -> 自动从备份恢复并保留损坏原始文本于恢复区
      vi.resetModules();
      const storageA = await import('../../../src/services/storage');
      const validBackupWorkspace = createDefaultWorkspace();
      validBackupWorkspace.conversations[0].title = '从备份救回的对话';

      storageMocks.asyncValues.set(WORKSPACE_KEY, '{broken-corrupted-json');
      storageMocks.asyncValues.set(
        WORKSPACE_BACKUP_KEY,
        JSON.stringify({
          schemaVersion: 7,
          revision: 2,
          savedAt: 999,
          workspace: validBackupWorkspace,
        })
      );

      const recovered = await storageA.loadWorkspace();
      expect(recovered?.conversations[0]?.title).toBe('从备份救回的对话');
      expect(storageA.consumeStorageRecoveryNotice()).toContain('备份恢复');
      // 再次消费应返回 null（一次性通知）
      expect(storageA.consumeStorageRecoveryNotice()).toBeNull();
      expect(storageMocks.asyncValues.get(WORKSPACE_RECOVERY_KEY)).toContain(
        '{broken-corrupted-json'
      );

      // 场景 B：无备份且主存储损坏 -> loadWorkspace 抛错并锁死 saveWorkspace 防止覆盖，WorkspaceSession 进入 read-only
      vi.resetModules();
      storageMocks.asyncValues.clear();
      const storageB = await import('../../../src/services/storage');
      storageMocks.asyncValues.set(WORKSPACE_KEY, '{unrecoverable-corrupt-json');

      await expect(storageB.loadWorkspace()).rejects.toThrow(/只读|工作区加载失败/);
      await expect(storageB.saveWorkspace(createDefaultWorkspace())).rejects.toThrow(
        /暂停自动保存|禁止保存/
      );
      // 损坏原数据未被覆盖
      expect(storageMocks.asyncValues.get(WORKSPACE_KEY)).toBe('{unrecoverable-corrupt-json');

      const readOnlyHarness = await createE2EWorkspaceHarness({
        persistenceOptions: { loadError: new Error('损坏工作区隔离') },
      });
      restoreCallbacks.push(() => readOnlyHarness.dispose());
      expect(readOnlyHarness.session.isReadOnly()).toBe(true);
      const writeAccepted = await readOnlyHarness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: readOnlyHarness.session.getSnapshot().activeConversationId,
        text: '只读模式不得写入',
        now: readOnlyHarness.clock.now(),
      });
      expect(writeAccepted).toBe(false);
    });

    it('F8-T2-2: 并发多请求决策必须 FIFO 排队依次解决（费用确认 & MCP 审批）', async () => {
      // 注意：当前既有单元测试 tests/chat-request-decisions.test.ts:22-34 断言第 2 个并发费用确认立即返回 false；
      // M2/F8 落地 FIFO 排队改造时需同步更新该单元测试为 FIFO 排队语义。
      const queue = new ChatRequestDecisionQueue();
      queue.activate();
      restoreCallbacks.push(() => queue.dispose());

      // 并发发起 2 个费用确认请求，队列应先呈现第 1 个，解决后自动弹出第 2 个，绝不静默立即拒绝第 2 个
      const cost1Promise = queue.requestCostConfirmation('第一次高费用警告');
      const cost2Promise = queue.requestCostConfirmation('第二次高费用警告');

      expect(queue.getSnapshot().costConfirmationReason).toBe('第一次高费用警告');
      let cost2SettledEarly = false;
      void cost2Promise.then(() => {
        cost2SettledEarly = true;
      });
      await Promise.resolve();
      expect(
        cost2SettledEarly,
        '并发发起第二个费用确认时不应立即拒绝，而应进入 FIFO 等待队列'
      ).toBe(false);

      queue.resolveCostConfirmation(true);
      await expect(raceWithTimeout(cost1Promise, 'cost1')).resolves.toBe(true);

      await Promise.resolve();
      expect(queue.getSnapshot().costConfirmationReason).toBe('第二次高费用警告');
      queue.resolveCostConfirmation(false);
      await expect(raceWithTimeout(cost2Promise, 'cost2')).resolves.toBe(false);
      expect(queue.getSnapshot().costConfirmationReason).toBeNull();

      // 并发发起 2 个 MCP 审批请求，同样须 FIFO 排队依次解决
      const mcp1Promise = queue.requestMcpApproval(makeMcpRequest('fifo-mcp-1', 'tool_a'), {
        providerName: 'OpenAI',
        modelId: 'gpt-5',
        serverName: 'MCP-1',
        endpoint: 'https://mcp.example.com/1',
      });
      const mcp2Promise = queue.requestMcpApproval(makeMcpRequest('fifo-mcp-2', 'tool_b'), {
        providerName: 'OpenAI',
        modelId: 'gpt-5',
        serverName: 'MCP-2',
        endpoint: 'https://mcp.example.com/2',
      });

      const firstView = queue.getSnapshot().mcpApprovalView;
      expect(firstView?.approvalRequestId).toBe('fifo-mcp-1');
      if (!firstView) throw new Error('Expected first queued MCP view.');

      queue.resolveMcpApproval(
        { approvalRequestId: firstView.approvalRequestId, nonce: firstView.approvalNonce },
        'approve'
      );
      await expect(raceWithTimeout(mcp1Promise, 'mcp1')).resolves.toBe('approve');

      await Promise.resolve();
      const secondView = queue.getSnapshot().mcpApprovalView;
      expect(
        secondView?.approvalRequestId,
        '第一个 MCP 审批结束后，队列应自动弹出第二个 MCP 审批视图'
      ).toBe('fifo-mcp-2');
      if (!secondView) throw new Error('Expected second queued MCP view.');

      queue.resolveMcpApproval(
        { approvalRequestId: secondView.approvalRequestId, nonce: secondView.approvalNonce },
        'deny'
      );
      await expect(raceWithTimeout(mcp2Promise, 'mcp2')).resolves.toBe('deny');
    });

    it('F8-T2-3: cancelAll、AbortSignal 与 dispose 全路径取消防死锁与防重放', async () => {
      const queue = new ChatRequestDecisionQueue();
      queue.activate();
      restoreCallbacks.push(() => queue.dispose());

      // 1) cancelAll 同时结算挂起的费用确认与 MCP 审批
      const pCost = queue.requestCostConfirmation('挂起费用');
      const pMcp = queue.requestMcpApproval(makeMcpRequest('cancel-all-1'), {
        providerName: 'OpenAI',
        modelId: 'gpt-5',
        serverName: 'MCP',
        endpoint: 'https://mcp.example.com',
      });
      queue.cancelAll();
      await expect(raceWithTimeout(pCost, 'cancelAll cost')).resolves.toBe(false);
      await expect(raceWithTimeout(pMcp, 'cancelAll mcp')).resolves.toBe('cancel');
      expect(queue.getSnapshot().costConfirmationReason).toBeNull();
      expect(queue.getSnapshot().mcpApprovalView).toBeNull();

      // 2) AbortSignal 中途触发 abort 与传入已 aborted signal
      const ac = new AbortController();
      const pAbortMcp = queue.requestMcpApproval(
        makeMcpRequest('abort-sig-1'),
        {
          providerName: 'OpenAI',
          modelId: 'gpt-5',
          serverName: 'MCP',
          endpoint: 'https://mcp.example.com',
        },
        ac.signal
      );
      const staleView = queue.getSnapshot().mcpApprovalView;
      ac.abort();
      await expect(raceWithTimeout(pAbortMcp, 'aborted mcp')).resolves.toBe('cancel');

      // 过期 token 重放必须被静默忽略且不影响下一审批
      if (staleView) {
        queue.resolveMcpApproval(
          { approvalRequestId: staleView.approvalRequestId, nonce: staleView.approvalNonce },
          'approve'
        );
      }
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      const pImmediateCancel = queue.requestMcpApproval(
        makeMcpRequest('abort-sig-2'),
        {
          providerName: 'OpenAI',
          modelId: 'gpt-5',
          serverName: 'MCP',
          endpoint: 'https://mcp.example.com',
        },
        alreadyAborted.signal
      );
      await expect(raceWithTimeout(pImmediateCancel, 'pre-aborted mcp')).resolves.toBe('cancel');

      // 3) dispose 结算一切挂起请求且阻止后续悬空请求，activate 可重新激活
      const pBeforeDispose = queue.requestCostConfirmation('即将销毁');
      queue.dispose();
      await expect(raceWithTimeout(pBeforeDispose, 'dispose cost')).resolves.toBe(false);
      await expect(
        raceWithTimeout(queue.requestCostConfirmation('销毁后请求'), 'post-dispose cost')
      ).resolves.toBe(false);

      queue.activate();
      const pReactivated = queue.requestCostConfirmation('重新激活后');
      expect(queue.getSnapshot().costConfirmationReason).toBe('重新激活后');
      queue.resolveCostConfirmation(true);
      await expect(raceWithTimeout(pReactivated, 'reactivated cost')).resolves.toBe(true);
    });

    it('F8-T2-4: 版本冲突 revision-mismatch、replacing 租赁拦截与 historyLocked 拒绝保护', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      const port = harness.session.bindCommitPort<string, boolean>((workspace, nextTitle) => ({
        workspace: {
          ...workspace,
          conversations: workspace.conversations.map((c, idx) =>
            idx === 0 ? { ...c, title: nextTitle } : c
          ),
        },
        result: true,
      }));

      const staleRevision = harness.session.getRevision();
      await port.execute('最新标题', { expectedRevision: staleRevision });
      expect(harness.session.getRevision()).toBe(staleRevision + 1);

      // 过期 revision 必须抛 revision-mismatch
      let caughtCode = '';
      try {
        await port.execute('陈旧标题', { expectedRevision: staleRevision });
      } catch (error) {
        if (error instanceof WorkspaceCommitRejectedError) {
          caughtCode = error.code;
        }
      }
      expect(caughtCode).toBe('revision-mismatch');

      // replace() 租赁期间并发写入必须被拦截为 'replacing'
      const importDeferred = createDeferred();
      const replacePromise = harness.session.replace(async () => {
        await importDeferred.promise;
        return createDefaultWorkspace();
      });

      expect(harness.session.isReplacing()).toBe(true);
      await expect(port.execute('导入期间写入')).rejects.toMatchObject({ code: 'replacing' });
      importDeferred.resolve();
      await replacePromise;
      expect(harness.session.isWritable()).toBe(true);

      // strict flush 失败时 replace 中止并恢复 ready，不丢弃脏数据
      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: harness.session.getSnapshot().activeConversationId,
        text: '待保护草稿',
        now: harness.clock.now(),
      });
      harness.persistence.setSaveError(new Error('模拟磁盘只读'));
      await expect(
        harness.session.replace(async () => createDefaultWorkspace())
      ).rejects.toThrow(/模拟磁盘只读/);
      harness.persistence.setSaveError(null);
      expect(harness.session.isWritable()).toBe(true);
      expect(harness.session.getStatus().dirty).toBe(true);

      // historyLocked 期间，修改请求上下文命令（delete/fork/create）均被拒绝且不改快照
      const lockedRuntime = new ProjectsConversationsRuntime({
        commit: harness.session.bindCommitPort(createProjectsCommitReducer()),
        now: () => harness.clock.now(),
        createId: (prefix) => harness.ids.createId(prefix),
        isHistoryLocked: () => true,
      });
      const revBeforeLock = harness.session.getRevision();
      const lockedCreate = await lockedRuntime.execute({
        type: 'project.create',
        input: { name: '锁定新建' },
      });
      expect(lockedCreate.ok).toBe(false);
      const lockedDel = await lockedRuntime.execute({
        type: 'conversation.delete',
        conversationId: harness.session.getSnapshot().activeConversationId,
      });
      expect(lockedDel.ok).toBe(false);
      expect(harness.session.getRevision()).toBe(revBeforeLock);
    });

    it('F8-T2-5: 全局搜索极端边界：正则特殊字符、超长截断、1500 文档预算与非法 limit', () => {
      const longToken = `${'x'.repeat(210)}tail`;
      const longContent = `${'前导文本 '.repeat(900)}TAIL_MARKER_OUT_OF_4000`;
      const messages: ChatMessage[] = Array.from({ length: 1550 }, (_, idx) => ({
        id: `msg-${idx}`,
        role: 'user',
        content: idx === 0 ? 'OLDEST_DROPPED_TOKEN' : `第 ${idx} 条内容 *+?([bad`,
        createdAt: idx + 1,
        status: 'ready',
      }));

      const source = {
        projects: [],
        promptTemplates: [],
        conversations: [
          {
            id: 'conv-huge',
            title: '超大规模测试会话',
            createdAt: 1,
            updatedAt: 9999,
            messages: [
              ...messages,
              {
                id: 'msg-long',
                role: 'assistant' as const,
                content: longContent,
                createdAt: 99999,
                status: 'ready' as const,
              },
            ],
          },
        ],
      };

      const index = buildWorkspaceSearchIndex(source);
      expect(index.documents.length).toBe(MAX_WORKSPACE_SEARCH_DOCUMENTS);

      // 正则元字符不得抛 SyntaxError，须按字面匹配
      const regexCharResults = searchWorkspaceIndex(index, '*+?([bad', { limit: 999 });
      expect(regexCharResults.length).toBe(MAX_WORKSPACE_SEARCH_RESULTS);

      // 最旧消息因超过 1500 文档预算而被裁剪，最新消息留存
      expect(searchWorkspaceIndex(index, 'OLDEST_DROPPED_TOKEN')).toEqual([]);

      // 超过 4000 字符字段截断与超过 200 字符查询截断
      expect(searchWorkspaceIndex(index, 'TAIL_MARKER_OUT_OF_4000')).toEqual([]);
      expect(searchWorkspaceIndex(index, longToken)).toEqual([]);

      // 非法或 0 limit 返回空数组
      expect(searchWorkspaceIndex(index, '*+?([bad', { limit: 0 })).toEqual([]);
      expect(searchWorkspaceIndex(index, '*+?([bad', { limit: -5 })).toEqual([]);
      expect(searchWorkspaceIndex(index, '*+?([bad', { limit: Number.NaN })).toEqual([]);
    });

    it('F8-T2-6: 持久化写前/写后失败恢复与在途并发脏状态不丢失', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      const convId = harness.session.getSnapshot().activeConversationId;

      // 1) 写前失败：后台防抖保存报错，status.issue 暴露错误且保持 dirty === true
      harness.persistence.setSaveError(new Error('磁盘配额已满'));
      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: '写前失败草稿',
        now: harness.clock.now(),
      });
      harness.clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
      await harness.session.settle();

      expect(harness.session.getStatus().dirty).toBe(true);
      expect(harness.session.getStatus().issue).toContain('磁盘配额已满');

      // 清除故障并显式 flush 成功后清除 issue
      harness.persistence.setSaveError(null);
      await harness.flush();
      expect(harness.session.getStatus().dirty).toBe(false);
      expect(harness.session.getStatus().issue).toBeUndefined();

      // 2) 写后错误（after-public-commit）：同样须保留 dirty 并暴露 issue
      harness.persistence.setPostCommitSaveError(new Error('SecureStore 凭证写入失败'));
      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: '写后错误草稿',
        now: harness.clock.now(),
      });
      await expect(harness.flush()).rejects.toThrow(/SecureStore 凭证写入失败/);
      expect(harness.session.getStatus().dirty).toBe(true);
      expect(harness.session.getStatus().issue).toContain('SecureStore 凭证写入失败');

      // 3) 在途 flush 期间产生新 commit，完成后不得抹除新 commit 的 dirty 标志
      harness.persistence.setPostCommitSaveError(null);
      const saveStarted = createDeferred();
      const saveGate = createDeferred();
      const originalSave = harness.persistence.save.bind(harness.persistence);
      const saveSpy = vi
        .spyOn(harness.persistence, 'save')
        .mockImplementationOnce((workspace) => {
          saveStarted.resolve();
          return saveGate.promise.then(() => originalSave(workspace));
        });

      const inFlightFlush = harness.session.flush({
        reason: 'concurrent-test',
        propagateFailure: true,
      });
      await saveStarted.promise;
      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: '在途并发更新草稿',
        now: harness.clock.now(),
      });
      saveGate.resolve();
      await inFlightFlush;
      saveSpy.mockRestore();

      // 新 commit 产生于第一轮 flush 在途期间，dirty 必须仍为 true
      expect(harness.session.getStatus().dirty).toBe(true);
      await harness.flush();
      expect(harness.session.getStatus().dirty).toBe(false);
      expect(
        harness.persistence
          .getStoredSnapshot()
          ?.composerDrafts.some((d) => d.text === '在途并发更新草稿')
      ).toBe(true);
    });
  });
});
