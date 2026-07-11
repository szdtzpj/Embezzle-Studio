import type { ChatMessage } from '../domain/types';
import { estimateTextTokens } from './tokenEstimate';

const defaultMaxMessages = 48;
const defaultMaxCharacters = 50_000;
const minimumCharacterBudget = 16_000;
const maximumCharacterBudget = 200_000;

export interface ChatTranscriptPolicy {
  excludedMessageIds?: readonly string[] | ReadonlySet<string>;
  pinnedMessageIds?: readonly string[] | ReadonlySet<string>;
  /** Optional stricter text/attachment character budget reserved by a caller. */
  maxCharacters?: number;
  /** Optional text-token estimate budget after caller-owned context is reserved. */
  maxEstimatedTokens?: number;
}

function idSet(value: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!value) return new Set<string>();
  return value instanceof Set ? value : new Set(value);
}

function isUsableMessage(message: ChatMessage): boolean {
  return (
    message.id !== 'welcome' &&
    message.status === 'ready' &&
    (Boolean(message.content.trim()) || Boolean(message.attachments?.length))
  );
}

function comparisonContextSelection(messages: ChatMessage[]): Set<string> {
  const selectedByGroup = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.comparisonGroupId &&
      message.selectedForContext === true &&
      message.status === 'ready' &&
      !selectedByGroup.has(message.comparisonGroupId)
    ) {
      selectedByGroup.set(message.comparisonGroupId, message.id);
    }
  }
  return new Set(selectedByGroup.values());
}

function messageCharacterCost(message: ChatMessage): number {
  const attachmentCost = (message.attachments ?? []).reduce((total, attachment) => {
    const bytes = attachment.size ?? (attachment.base64 ? Math.ceil(attachment.base64.length * 0.75) : 750);
    return total + Math.ceil(bytes * 4 / 3);
  }, 0);
  return message.content.length + (message.reasoningContent?.length ?? 0) + attachmentCost;
}

function messageEstimatedTokenCost(message: ChatMessage): number {
  return estimateTextTokens(message.content) + 4;
}

function contextCharacterBudget(contextWindow?: number): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return defaultMaxCharacters;
  }

  // Tokenization depends on the model and language. A conservative character
  // budget leaves room for the response and request framing without pretending
  // to be an exact tokenizer.
  return Math.max(
    minimumCharacterBudget,
    Math.min(maximumCharacterBudget, Math.floor(contextWindow * 2.4))
  );
}

/**
 * Builds a bounded, causally valid transcript for a chat request.
 *
 * System messages are retained first. Conversation history is grouped into
 * user-led turns so trimming never starts with an orphan assistant response.
 * Pending, failed, and cancelled messages are excluded from later requests.
 */
export function buildChatTranscript(
  messages: ChatMessage[],
  contextWindow?: number,
  maxMessages = defaultMaxMessages,
  policy: ChatTranscriptPolicy = {}
): ChatMessage[] {
  const boundedMaxMessages = Number.isFinite(maxMessages)
    ? Math.max(1, Math.floor(maxMessages))
    : defaultMaxMessages;
  const excludedIds = idSet(policy.excludedMessageIds);
  const pinnedIds = idSet(policy.pinnedMessageIds);
  const selectedComparisonMessages = comparisonContextSelection(messages);
  const usable = messages.filter(
    (message) =>
      isUsableMessage(message) &&
      (
        message.role !== 'assistant' ||
        !message.comparisonGroupId ||
        selectedComparisonMessages.has(message.id)
      )
  );
  const isExcluded = (message: ChatMessage) =>
    message.excludedFromContext === true || excludedIds.has(message.id);
  const allSystemMessages = usable.filter(
    (message) => message.role === 'system' && !isExcluded(message)
  );
  const conversational = usable.filter((message) => message.role !== 'system');
  const rawTurns: ChatMessage[][] = [];

  for (const message of conversational) {
    if (message.role === 'user') {
      rawTurns.push([message]);
      continue;
    }

    const currentTurn = rawTurns.at(-1);
    if (currentTurn) {
      currentTurn.push(message);
    }
  }
  const turns = rawTurns
    // Excluding a user message excludes its complete turn. Otherwise an
    // assistant that originally answered it could be reattached to an older
    // user message after filtering.
    .filter((turn) => !isExcluded(turn[0]))
    .map((turn) => turn.filter((message) => !isExcluded(message)))
    .filter((turn) => turn.length > 0);
  const latestTurnLength = turns.at(-1)?.length ?? 0;
  const systemMessages = allSystemMessages.slice(
    0,
    Math.max(0, boundedMaxMessages - latestTurnLength)
  );

  const requestedBudget = policy.maxCharacters;
  const budget = requestedBudget !== undefined && Number.isFinite(requestedBudget)
    ? Math.max(0, Math.floor(requestedBudget))
    : contextCharacterBudget(contextWindow);
  const selectedTurnIndexes = new Set<number>();
  if (turns.length) {
    // The newest usable user-led turn is always retained.
    selectedTurnIndexes.add(turns.length - 1);
  }

  let selectedCharacters = systemMessages.reduce(
    (total, message) => total + messageCharacterCost(message),
    0
  );
  let selectedMessages = systemMessages.length;
  let selectedEstimatedTokens = systemMessages.reduce(
    (total, message) => total + messageEstimatedTokenCost(message),
    0
  );
  const requestedTokenBudget = policy.maxEstimatedTokens;
  const tokenBudget = requestedTokenBudget !== undefined && Number.isFinite(requestedTokenBudget)
    ? Math.max(0, Math.floor(requestedTokenBudget))
    : undefined;

  for (const index of selectedTurnIndexes) {
    selectedCharacters += turns[index].reduce(
      (total, message) => total + messageCharacterCost(message),
      0
    );
    selectedMessages += turns[index].length;
    selectedEstimatedTokens += turns[index].reduce(
      (total, message) => total + messageEstimatedTokenCost(message),
      0
    );
  }

  // Pins receive priority over ordinary history, newest first, but cannot
  // bypass the same request-size limits. This prevents a large number of
  // persisted pin flags from turning a bounded transcript into an unbounded
  // provider request. A retained pinned assistant always brings its complete
  // user-led turn; pins that do not fit remain visible as trimmed in the local
  // context inspector.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (selectedTurnIndexes.has(index)) continue;
    const turn = turns[index];
    if (!turn.some((message) => message.pinnedForContext === true || pinnedIds.has(message.id))) {
      continue;
    }
    const turnCharacters = turn.reduce(
      (total, message) => total + messageCharacterCost(message),
      0
    );
    const turnEstimatedTokens = turn.reduce(
      (total, message) => total + messageEstimatedTokenCost(message),
      0
    );
    if (
      selectedCharacters + turnCharacters > budget ||
      selectedMessages + turn.length > boundedMaxMessages ||
      (tokenBudget !== undefined &&
        selectedEstimatedTokens + turnEstimatedTokens > tokenBudget)
    ) {
      continue;
    }
    selectedTurnIndexes.add(index);
    selectedCharacters += turnCharacters;
    selectedMessages += turn.length;
    selectedEstimatedTokens += turnEstimatedTokens;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (selectedTurnIndexes.has(index)) continue;
    const turn = turns[index];
    const turnCharacters = turn.reduce(
      (total, message) => total + messageCharacterCost(message),
      0
    );
    const turnEstimatedTokens = turn.reduce(
      (total, message) => total + messageEstimatedTokenCost(message),
      0
    );
    const exceedsBudget = selectedCharacters + turnCharacters > budget;
    const exceedsCount = selectedMessages + turn.length > boundedMaxMessages;
    const exceedsTokenBudget = tokenBudget !== undefined &&
      selectedEstimatedTokens + turnEstimatedTokens > tokenBudget;

    if (exceedsBudget || exceedsCount || exceedsTokenBudget) continue;

    selectedTurnIndexes.add(index);
    selectedCharacters += turnCharacters;
    selectedMessages += turn.length;
    selectedEstimatedTokens += turnEstimatedTokens;
  }

  const selectedTurns = turns.filter((_, index) => selectedTurnIndexes.has(index));
  return [...systemMessages, ...selectedTurns.flat()];
}
