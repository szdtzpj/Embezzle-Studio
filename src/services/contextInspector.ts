import type { ChatMessage } from '../domain/types';
import type { ProjectKnowledgeContextResult } from './projectKnowledge';
import { buildChatTranscript } from './conversationContext';
import { estimateTextTokens } from './tokenEstimate';

export { estimateTextTokens } from './tokenEstimate';

export const LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID = 'local-project-knowledge-context';
export const MAX_KNOWLEDGE_CONTEXT_CHARACTERS = 30_000;

export interface RequestContextInspection {
  transcript: ChatMessage[];
  includedMessageIds: string[];
  excludedMessageIds: string[];
  trimmedMessageIds: string[];
  pinnedMessageIds: string[];
  estimatedInputTokens: number;
  contextWindow?: number;
  contextWindowRemainingEstimate?: number;
  exceedsRecommendedContextBudget: boolean;
  exceedsContextWindow: boolean;
  contextBudgetUncertain: boolean;
  attachmentCount: number;
  unknownAttachmentTokenCount: number;
  knowledgeCharacters: number;
  includedKnowledgeSourceIds: string[];
  missingKnowledgeSourceIds: string[];
  omittedKnowledgeSourceIds: string[];
  knowledgeTruncated: boolean;
}

export interface RequestContextOptions {
  contextWindow?: number;
  maxMessages?: number;
  knowledgeContext?: string;
  knowledgeContextResult?: ProjectKnowledgeContextResult;
  excludedMessageIds?: readonly string[];
  pinnedMessageIds?: readonly string[];
}

function knowledgeSystemMessage(content: string): ChatMessage | undefined {
  const bounded = Array.from(content.trim()).slice(0, MAX_KNOWLEDGE_CONTEXT_CHARACTERS).join('');
  if (!bounded) return undefined;
  return {
    id: LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID,
    role: 'system',
    content: bounded,
    createdAt: 0,
    status: 'ready',
  };
}

export function composeRequestTranscript(
  messages: ChatMessage[],
  options: RequestContextOptions = {}
): ChatMessage[] {
  const knowledgeContent = options.knowledgeContext ?? options.knowledgeContextResult?.text ?? '';
  const knowledgeMessage = knowledgeSystemMessage(knowledgeContent);
  const contextWindow = options.contextWindow && Number.isFinite(options.contextWindow)
    ? Math.max(1, Math.floor(options.contextWindow))
    : undefined;
  const reservedInputTokens = contextWindow ? Math.floor(contextWindow * 0.8) : undefined;
  const remainingTextTokens = reservedInputTokens === undefined
    ? undefined
    : Math.max(0, reservedInputTokens - (knowledgeMessage
      ? estimateTextTokens(knowledgeMessage.content) + 4
      : 0));
  const transcript = buildChatTranscript(
    messages,
    options.contextWindow,
    options.maxMessages,
    {
      excludedMessageIds: options.excludedMessageIds,
      pinnedMessageIds: options.pinnedMessageIds,
      ...(remainingTextTokens !== undefined
        ? { maxEstimatedTokens: remainingTextTokens }
        : {}),
    }
  );
  if (!knowledgeMessage) return transcript;

  const firstConversationIndex = transcript.findIndex((message) => message.role !== 'system');
  if (firstConversationIndex < 0) return [...transcript, knowledgeMessage];
  return [
    ...transcript.slice(0, firstConversationIndex),
    knowledgeMessage,
    ...transcript.slice(firstConversationIndex),
  ];
}

function candidateMessageIds(messages: ChatMessage[]): string[] {
  return messages
    .filter(
      (message) =>
        message.id !== 'welcome' &&
        message.status === 'ready' &&
        (message.content.trim() || message.attachments?.length)
    )
    .map((message) => message.id);
}

export function inspectRequestContext(
  messages: ChatMessage[],
  options: RequestContextOptions = {}
): RequestContextInspection {
  const transcript = composeRequestTranscript(messages, options);
  const includedMessageIds = transcript
    .filter((message) => message.id !== LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID)
    .map((message) => message.id);
  const included = new Set(includedMessageIds);
  const explicitExcluded = new Set(options.excludedMessageIds ?? []);
  const excludedMessageIds = messages
    .filter(
      (message) =>
        message.excludedFromContext === true || explicitExcluded.has(message.id)
    )
    .map((message) => message.id);
  const excluded = new Set(excludedMessageIds);
  const trimmedMessageIds = candidateMessageIds(messages).filter(
    (id) => !included.has(id) && !excluded.has(id)
  );
  const explicitPinned = new Set(options.pinnedMessageIds ?? []);
  const pinnedMessageIds = messages
    .filter((message) => message.pinnedForContext === true || explicitPinned.has(message.id))
    .map((message) => message.id);
  const attachmentCount = transcript.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0
  );
  const unknownAttachmentTokenCount = attachmentCount;
  const estimatedInputTokens = transcript.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    0
  );
  const contextWindow = options.contextWindow && Number.isFinite(options.contextWindow)
    ? Math.max(1, Math.floor(options.contextWindow))
    : undefined;
  const recommendedBudget = contextWindow ? Math.floor(contextWindow * 0.8) : undefined;
  const hardTextBudget = contextWindow ? Math.floor(contextWindow * 0.9) : undefined;
  const knowledgeResult = options.knowledgeContextResult;

  return {
    transcript,
    includedMessageIds,
    excludedMessageIds,
    trimmedMessageIds,
    pinnedMessageIds,
    estimatedInputTokens,
    ...(contextWindow && attachmentCount === 0 ? {
      contextWindow,
      contextWindowRemainingEstimate: Math.max(0, contextWindow - estimatedInputTokens),
    } : contextWindow ? { contextWindow } : {}),
    exceedsRecommendedContextBudget: recommendedBudget !== undefined &&
      estimatedInputTokens > recommendedBudget,
    exceedsContextWindow: hardTextBudget !== undefined && estimatedInputTokens > hardTextBudget,
    contextBudgetUncertain: attachmentCount > 0,
    attachmentCount,
    unknownAttachmentTokenCount,
    knowledgeCharacters: transcript.find(
      (message) => message.id === LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID
    )?.content.length ?? 0,
    includedKnowledgeSourceIds: [...(knowledgeResult?.includedSourceIds ?? [])],
    missingKnowledgeSourceIds: [...(knowledgeResult?.missingSourceIds ?? [])],
    omittedKnowledgeSourceIds: [...(knowledgeResult?.omittedSourceIds ?? [])],
    knowledgeTruncated: knowledgeResult?.truncated ?? false,
  };
}
